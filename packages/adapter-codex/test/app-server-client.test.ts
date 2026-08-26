import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerClient } from "../src/index.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: unknown[] = [];
  readonly waiters: Array<(message: any) => void> = [];
  private buffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const message = JSON.parse(line);
        this.messages.push(message);
        this.waiters.shift()?.(message);
        newline = this.buffer.indexOf("\n");
      }
    });
    this.stdin.once("finish", () => this.emit("exit", 0, null));
  }

  async nextMessage(): Promise<any> {
    const message = this.messages.shift();
    if (message !== undefined) return message;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  respond(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(): boolean {
    this.emit("exit", 0, "SIGTERM");
    return true;
  }
}

describe("CodexAppServerClient", () => {
  it("speaks initialized JSONL, streams a turn, declines stray approvals, and stops", async () => {
    const process = new FakeProcess();
    let spawnSpec: { args: string[] } | undefined;
    const client = new CodexAppServerClient({
      processFactory: (spec) => {
        spawnSpec = spec;
        return process as unknown as ChildProcessWithoutNullStreams;
      },
      requestTimeoutMs: 1_000,
    });

    const starting = client.start();
    const initialize = await process.nextMessage();
    expect(spawnSpec?.args).toEqual(
      expect.arrayContaining([
        'model_provider="wecom_http"',
        'model_providers.wecom_http.base_url="https://chatgpt.com/backend-api/codex"',
        "model_providers.wecom_http.requires_openai_auth=true",
        "model_providers.wecom_http.supports_websockets=false",
      ]),
    );
    expect(initialize).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "fyaic_wecom_agent_gateway" } },
    });
    process.respond({ id: initialize.id, result: { userAgent: "test" } });
    await starting;
    expect(await process.nextMessage()).toEqual({
      method: "initialized",
      params: {},
    });

    const threadStarting = client.startThread({
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadRequest = await process.nextMessage();
    expect(threadRequest).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: "read-only",
      },
    });
    process.respond({
      id: threadRequest.id,
      result: { thread: { id: "thread-1" } },
    });
    expect(await threadStarting).toBe("thread-1");

    const turnStarting = client.runTurn(
      "thread-1",
      [{ type: "text", text: "hello", text_elements: [] }],
      { effort: "low" },
    );
    const turnRequest = await process.nextMessage();
    expect(turnRequest).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        effort: "low",
      },
    });
    process.respond({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "你",
      },
    });
    process.respond({
      id: turnRequest.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    const events = await turnStarting;
    process.respond({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    const actual = [];
    for await (const event of events) actual.push(event.method);
    expect(actual).toEqual(["item/agentMessage/delta", "turn/completed"]);

    process.respond({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2" },
    });
    expect(await process.nextMessage()).toEqual({
      id: 99,
      result: { decision: "decline" },
    });

    expect(client.health()).toEqual({ ok: true });
    await client.stop();
    expect(client.health()).toEqual({
      ok: false,
      detail: "Codex app-server is not initialized",
    });
  });

  it("surfaces native user-input requests and answers the same server request", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient({
      processFactory: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 1_000,
    });

    const starting = client.start();
    const initialize = await process.nextMessage();
    expect(initialize.params.capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
    process.respond({ id: initialize.id, result: { userAgent: "test" } });
    await starting;
    await process.nextMessage();

    const turnStarting = client.runTurn(
      "thread-1",
      [{ type: "text", text: "ask", text_elements: [] }],
      {},
    );
    const turnRequest = await process.nextMessage();
    process.respond({
      id: turnRequest.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    const events = await turnStarting;
    const iterator = events[Symbol.asyncIterator]();
    process.respond({
      id: "server-request-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        autoResolutionMs: 30_000,
        questions: [
          {
            id: "environment",
            header: "环境",
            question: "选择目标环境",
            isOther: false,
            isSecret: false,
            options: [
              { label: "生产", description: "正式流量" },
              { label: "测试", description: "测试流量" },
            ],
          },
        ],
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        method: "item/tool/requestUserInput",
        requestId: "server-request-1",
      },
    });

    await client.respondToUserInput("server-request-1", {
      answers: { environment: { answers: ["测试"] } },
    });
    expect(await process.nextMessage()).toEqual({
      id: "server-request-1",
      result: { answers: { environment: { answers: ["测试"] } } },
    });
    process.respond({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { method: "turn/completed" },
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await client.stop();
  });

  it("surfaces a redacted app-server startup diagnostic", async () => {
    const process = new FakeProcess();
    const client = new CodexAppServerClient({
      processFactory: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 1_000,
    });

    const starting = client.start();
    await process.nextMessage();
    process.stderr.write(
      "config error: api_key=should-not-leak invalid provider\n",
    );
    process.emit("exit", 1, null);

    await expect(starting).rejects.toThrow(
      "config error: api_key=[REDACTED] invalid provider",
    );
  });

  it("negotiates and answers experimental dynamic tool calls", async () => {
    const process = new FakeProcess();
    const calls: unknown[] = [];
    const client = new CodexAppServerClient({
      processFactory: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 1_000,
      dynamicToolHandler: async (call) => {
        calls.push(call);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "matched" }],
        };
      },
    });

    const starting = client.start();
    const initialize = await process.nextMessage();
    expect(initialize.params.capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
    process.respond({ id: initialize.id, result: { userAgent: "test" } });
    await starting;
    await process.nextMessage();

    process.respond({
      id: 41,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "wecom_contact_search",
        arguments: { keywords: ["Alice"] },
      },
    });

    expect(await process.nextMessage()).toEqual({
      id: 41,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "matched" }],
      },
    });
    expect(calls).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "wecom_contact_search",
        arguments: { keywords: ["Alice"] },
      },
    ]);
    await client.stop();
  });

  it("returns a generic failure without leaking dynamic tool diagnostics", async () => {
    const process = new FakeProcess();
    const errors: Error[] = [];
    const client = new CodexAppServerClient({
      processFactory: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 1_000,
      dynamicToolHandler: async () => {
        throw new Error("secret=must-not-reach-the-model");
      },
      onDynamicToolError: (error) => errors.push(error),
    });

    const starting = client.start();
    const initialize = await process.nextMessage();
    process.respond({ id: initialize.id, result: { userAgent: "test" } });
    await starting;
    await process.nextMessage();
    process.respond({
      id: 42,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-2",
        namespace: null,
        tool: "failing_tool",
        arguments: {},
      },
    });

    const response = await process.nextMessage();
    expect(response).toEqual({
      id: 42,
      result: {
        success: false,
        contentItems: [{ type: "inputText", text: "Tool execution failed." }],
      },
    });
    expect(JSON.stringify(response)).not.toContain("must-not-reach");
    expect(errors[0]?.message).toContain("must-not-reach");
    await client.stop();
  });
});
