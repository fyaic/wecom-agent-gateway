import { describe, expect, it } from "vitest";
import type {
  InboundMessage,
  RuntimeTool,
} from "@fyaic/wecom-runtime-contract";
import {
  CodexAppServerRuntimeAdapter,
  type CodexAppServerClientLike,
  type CodexAppServerEvent,
  type CodexAppServerInput,
  type CodexAppServerThreadOptions,
  type CodexAppServerTurnOptions,
} from "../src/index.js";
import { exerciseReplyActionRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";

const inbound: InboundMessage = {
  id: "m1",
  accountId: "bot",
  conversationId: "chat",
  conversationType: "direct",
  senderId: "user",
  receivedAt: "2026-08-20T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
};

class FakeAppServerClient implements CodexAppServerClientLike {
  started = false;
  readonly calls: unknown[] = [];
  events: CodexAppServerEvent[] = [];

  async start(): Promise<void> {
    this.started = true;
    this.calls.push(["start"]);
  }
  async stop(): Promise<void> {
    this.started = false;
    this.calls.push(["stop"]);
  }
  health(): { ok: boolean } {
    return { ok: this.started };
  }
  async startThread(options: CodexAppServerThreadOptions): Promise<string> {
    this.calls.push(["thread/start", options]);
    return "thread-1";
  }
  async resumeThread(
    threadId: string,
    options: CodexAppServerThreadOptions,
  ): Promise<void> {
    this.calls.push(["thread/resume", threadId, options]);
  }
  async runTurn(
    threadId: string,
    input: CodexAppServerInput[],
    options: CodexAppServerTurnOptions,
  ): Promise<AsyncIterable<CodexAppServerEvent>> {
    this.calls.push(["turn/start", threadId, input, options]);
    return asAsync(this.events);
  }
  async interrupt(threadId: string): Promise<void> {
    this.calls.push(["turn/interrupt", threadId]);
  }
}

describe("CodexAppServerRuntimeAdapter", () => {
  it("maps persistent app-server events without injecting a semantic warmup", async () => {
    const client = new FakeAppServerClient();
    client.events = [
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "reasoning" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "你" },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "mcpToolCall" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", text: "你好" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      },
    ];
    const adapter = new CodexAppServerRuntimeAdapter({
      client,
      cwd: "/workspace",
      model: "test-model",
      serviceTier: "fast",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    });

    await adapter.start();
    const actual = [];
    for await (const event of adapter.run({ message: inbound })) {
      actual.push(event);
    }

    expect(actual).toEqual([
      { type: "session-started", sessionId: "thread-1" },
      { type: "status", phase: "thinking" },
      { type: "text-delta", text: "你" },
      { type: "status", phase: "tool-running" },
      { type: "message-completed", text: "你好" },
    ]);
    expect(client.calls).toContainEqual([
      "thread/start",
      {
        cwd: "/workspace",
        model: "test-model",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "read-only",
      },
    ]);
    expect(client.calls).toContainEqual([
      "turn/start",
      "thread-1",
      [{ type: "text", text: "hello", text_elements: [] }],
      {
        cwd: "/workspace",
        model: "test-model",
        serviceTier: "fast",
        effort: "low",
      },
    ]);
    expect(JSON.stringify(client.calls)).not.toContain("developerInstructions");
    expect(JSON.stringify(client.calls)).not.toContain("warmup");
  });

  it("resumes an existing opaque session once per process and supports cancel", async () => {
    const client = new FakeAppServerClient();
    client.events = [
      {
        method: "turn/completed",
        params: {
          threadId: "stored-thread",
          turn: { id: "turn-1", status: "completed" },
        },
      },
    ];
    const adapter = new CodexAppServerRuntimeAdapter({ client });

    for await (const _event of adapter.run({
      message: inbound,
      sessionId: "stored-thread",
    })) {
      void _event;
    }
    for await (const _event of adapter.run({
      message: inbound,
      sessionId: "stored-thread",
    })) {
      void _event;
    }
    await adapter.cancel("stored-thread");

    expect(
      client.calls.filter(
        (call) => Array.isArray(call) && call[0] === "thread/resume",
      ),
    ).toHaveLength(1);
    expect(client.calls.at(-1)).toEqual(["turn/interrupt", "stored-thread"]);
  });

  it("continues a reply action in the same App Server thread exactly once", async () => {
    const client = new FakeAppServerClient();
    client.events = [
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "stored-thread",
          turnId: "turn-2",
          delta: "continued",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "stored-thread",
          turnId: "turn-2",
          item: { type: "agentMessage", text: "continued" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "stored-thread",
          turn: { id: "turn-2", status: "completed" },
        },
      },
    ];
    const adapter = new CodexAppServerRuntimeAdapter({ client });
    const transcript = await exerciseReplyActionRuntimeContract(
      adapter,
      {
        ...inbound,
        id: "reply-action",
        parts: [{ type: "text", text: "continue" }],
      },
      "stored-thread",
    );
    expect(transcript.resumed.at(-1)).toEqual({
      type: "message-completed",
      text: "continued",
    });
    expect(
      client.calls.filter(
        (call) => Array.isArray(call) && call[0] === "turn/start",
      ),
    ).toHaveLength(1);
  });

  it("fails explicitly when Channel media has not been materialized", async () => {
    const client = new FakeAppServerClient();
    const adapter = new CodexAppServerRuntimeAdapter({ client });
    const events = adapter.run({
      message: {
        ...inbound,
        parts: [{ type: "file", name: "report.pdf" }],
      },
    });

    await expect(async () => {
      for await (const _event of events) void _event;
    }).rejects.toThrow("before Channel media materialization");
  });

  it("maps protected image and audio files to native App Server inputs", async () => {
    const client = new FakeAppServerClient();
    client.events = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      },
    ];
    const adapter = new CodexAppServerRuntimeAdapter({ client });

    for await (const _event of adapter.run({
      message: {
        ...inbound,
        parts: [
          { type: "text", text: "处理附件" },
          { type: "image", path: "/protected/image.png" },
          { type: "audio", path: "/protected/audio.m4a" },
        ],
      },
    })) {
      void _event;
    }

    expect(client.calls).toContainEqual([
      "turn/start",
      "thread-1",
      [
        { type: "text", text: "处理附件", text_elements: [] },
        { type: "localImage", path: "/protected/image.png" },
        { type: "localAudio", path: "/protected/audio.m4a" },
      ],
      {},
    ]);
    expect(adapter.capabilities.has("multimodal-input")).toBe(true);
    expect(adapter.inputModalities).toEqual(new Set(["image", "audio"]));
  });

  it("publishes only validated read-only runtime tools to new threads", async () => {
    const client = new FakeAppServerClient();
    client.events = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      },
    ];
    const tool: RuntimeTool = {
      name: "wecom_contact_search",
      description: "Search contacts",
      inputSchema: {
        type: "object",
        properties: { keywords: { type: "array" } },
      },
      effect: "read-only",
      approval: "never",
      async execute() {
        return { success: true, content: [{ type: "text", text: "ok" }] };
      },
    };
    const adapter = new CodexAppServerRuntimeAdapter({ client, tools: [tool] });

    expect(adapter.sessionCompatibilityId).toMatch(
      /^codex-app-server:tools:[a-f0-9]{16}$/,
    );

    for await (const _event of adapter.run({ message: inbound })) void _event;

    expect(client.calls).toContainEqual([
      "thread/start",
      {
        approvalPolicy: "never",
        sandbox: "read-only",
        dynamicTools: [
          {
            type: "function",
            name: "wecom_contact_search",
            description: "Search contacts",
            inputSchema: {
              type: "object",
              properties: { keywords: { type: "array" } },
            },
          },
        ],
      },
    ]);
  });

  it("executes a side-effecting tool only after the active run approves it", async () => {
    let executions = 0;
    const approvals: unknown[] = [];
    const tool: RuntimeTool = {
      name: "wecom_send_message",
      description: "Send a message",
      inputSchema: { type: "object" },
      effect: "write",
      approval: "required",
      approvalSummary() {
        return "Send the concrete approved message";
      },
      async execute() {
        executions += 1;
        return { success: true, content: [{ type: "text", text: "sent" }] };
      },
    };
    const adapter = new CodexAppServerRuntimeAdapter({ tools: [tool] });
    const activeRequests = (
      adapter as unknown as {
        activeRequests: Map<
          string,
          {
            message: InboundMessage;
            requestApproval: (request: unknown) => Promise<"approved">;
          }
        >;
      }
    ).activeRequests;
    activeRequests.set("thread-1", {
      message: inbound,
      requestApproval: async (request) => {
        approvals.push(request);
        return "approved";
      },
    });

    const result = await (
      adapter as unknown as {
        executeDynamicTool(call: {
          threadId: string;
          turnId: string;
          callId: string;
          namespace: null;
          tool: string;
          arguments: Record<string, never>;
        }): Promise<{ success: boolean }>;
      }
    ).executeDynamicTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "wecom_send_message",
      arguments: {},
    });

    expect(approvals).toEqual([
      {
        toolName: "wecom_send_message",
        effect: "write",
        summary: "Send the concrete approved message",
        maxWaitMs: 90_000,
      },
    ]);
    expect(executions).toBe(1);
    expect(result.success).toBe(true);
    expect(adapter.capabilities.has("approval")).toBe(true);
  });

  it("does not execute a side-effecting tool when approval is denied", async () => {
    let executions = 0;
    const tool: RuntimeTool = {
      name: "wecom_send_message",
      description: "Send a message",
      inputSchema: { type: "object" },
      effect: "write",
      approval: "required",
      async execute() {
        executions += 1;
        return { success: true, content: [{ type: "text", text: "sent" }] };
      },
    };
    const adapter = new CodexAppServerRuntimeAdapter({ tools: [tool] });
    const activeRequests = (
      adapter as unknown as {
        activeRequests: Map<
          string,
          {
            message: InboundMessage;
            requestApproval: () => Promise<"denied">;
          }
        >;
      }
    ).activeRequests;
    activeRequests.set("thread-1", {
      message: inbound,
      requestApproval: async () => "denied",
    });

    const result = await (
      adapter as unknown as {
        executeDynamicTool(call: {
          threadId: string;
          turnId: string;
          callId: string;
          namespace: null;
          tool: string;
          arguments: Record<string, never>;
        }): Promise<{ success: boolean; contentItems: unknown[] }>;
      }
    ).executeDynamicTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "wecom_send_message",
      arguments: {},
    });

    expect(executions).toBe(0);
    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Tool execution was denied." }],
    });
  });

  it("rejects an unsafe side-effecting tool without approval", () => {
    const tool: RuntimeTool = {
      name: "wecom_send_message",
      description: "Send a message",
      inputSchema: { type: "object" },
      effect: "write",
      approval: "never",
      async execute() {
        return { success: true, content: [{ type: "text", text: "sent" }] };
      },
    };

    expect(() => new CodexAppServerRuntimeAdapter({ tools: [tool] })).toThrow(
      "effect and approval policy are incompatible",
    );
  });
});

async function* asAsync<T>(events: T[]): AsyncIterable<T> {
  yield* events;
}
