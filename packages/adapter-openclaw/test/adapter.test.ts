import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exerciseReplyActionRuntimeContract,
  exerciseTextRuntimeContract,
} from "@fyaic/wecom-runtime-contract/testkit";
import { describe, expect, it } from "vitest";
import {
  OpenClawRuntimeAdapter,
  type OpenClawClientHandlers,
  type OpenClawGatewayClient,
} from "../src/index.js";

const inbound = {
  id: "message-1",
  accountId: "bot-account",
  conversationId: "conversation-1",
  conversationType: "direct" as const,
  senderId: "sender-1",
  receivedAt: "2026-08-24T00:00:00.000Z",
  parts: [{ type: "text" as const, text: "hello" }],
};

describe("OpenClawRuntimeAdapter", () => {
  it("satisfies the shared text and resume contract over chat.send", async () => {
    const fake = new FakeOpenClawClient();
    const adapter = createAdapter(fake);
    await adapter.start();

    const transcript = await exerciseTextRuntimeContract(adapter, inbound);

    expect(transcript.first.map((event) => event.type)).toContain(
      "session-started",
    );
    expect(transcript.resumed.map((event) => event.type)).not.toContain(
      "session-started",
    );
    const sends = fake.requests.filter(
      (request) => request.method === "chat.send",
    );
    expect(sends).toHaveLength(2);
    expect((sends[0].params as { sessionKey: string }).sessionKey).toBe(
      transcript.sessionId,
    );
    expect((sends[1].params as { sessionKey: string }).sessionKey).toBe(
      transcript.sessionId,
    );
    expect(adapter.capabilities).toEqual(
      new Set([
        "streaming",
        "resume",
        "cancel",
        "status-events",
        "multimodal-input",
        "interaction-resume",
        "reply-actions",
      ]),
    );
    expect(adapter.inputModalities).toEqual(
      new Set(["image", "audio", "video", "file"]),
    );
    await adapter.stop();
  });

  it("continues a reply action in the same OpenClaw session exactly once", async () => {
    const fake = new FakeOpenClawClient();
    const adapter = createAdapter(fake);
    await adapter.start();
    const transcript = await exerciseReplyActionRuntimeContract(
      adapter,
      {
        ...inbound,
        id: "reply-action",
        parts: [{ type: "text", text: "continue" }],
      },
      "stored-session",
    );
    expect(transcript.resumed.at(-1)).toEqual({
      type: "message-completed",
      text: "OpenClaw",
    });
    expect(
      fake.requests.filter((request) => request.method === "chat.send"),
    ).toHaveLength(1);
    expect(
      (
        fake.requests.find((request) => request.method === "chat.send")!
          .params as { idempotencyKey: string }
      ).idempotencyKey,
    ).toBe("reply-action:reply-action");
    await adapter.stop();
  });

  it("materializes local media as official chat attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-adapter-test-"));
    const imagePath = join(root, "pixel.png");
    const filePath = join(root, "report.pdf");
    const videoPath = join(root, "demo.mp4");
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    await writeFile(filePath, Buffer.from("pdf"));
    await writeFile(videoPath, Buffer.from("video"));
    const fake = new FakeOpenClawClient();
    const adapter = createAdapter(fake);
    await adapter.start();

    const events = [];
    for await (const event of adapter.run({
      message: {
        ...inbound,
        parts: [
          { type: "text", text: "describe" },
          {
            type: "image",
            path: imagePath,
            name: "pixel.png",
            mimeType: "image/png",
          },
          {
            type: "file",
            path: filePath,
            name: "report.pdf",
            mimeType: "application/pdf",
          },
          {
            type: "video",
            path: videoPath,
            name: "demo.mp4",
            mimeType: "video/mp4",
          },
        ],
      },
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: "message-completed" });
    const send = fake.requests.find(
      (request) => request.method === "chat.send",
    );
    const attachments = (
      send!.params as { attachments: Array<Record<string, unknown>> }
    ).attachments;
    expect(attachments).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        fileName: "pixel.png",
        content: Buffer.from([1, 2, 3, 4]).toString("base64"),
        sizeBytes: 4,
      }),
      expect.objectContaining({
        type: "file",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        sizeBytes: 3,
      }),
      expect.objectContaining({
        type: "video",
        mimeType: "video/mp4",
        fileName: "demo.mp4",
        sizeBytes: 5,
      }),
    ]);
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("maps cancel to chat.abort for the active OpenClaw run", async () => {
    const fake = new FakeOpenClawClient({ holdRuns: true });
    const adapter = createAdapter(fake);
    await adapter.start();
    const iterator = adapter.run({ message: inbound })[Symbol.asyncIterator]();
    const session = await iterator.next();
    expect(session.value).toMatchObject({ type: "session-started" });
    await iterator.next();
    const pending = iterator.next();
    await waitFor(() =>
      fake.requests.some((request) => request.method === "chat.send"),
    );

    await adapter.cancel(
      (session.value as { type: "session-started"; sessionId: string })
        .sessionId,
    );

    expect(fake.requests.at(-1)?.method).toBe("chat.abort");
    fake.finishHeldRun();
    await pending;
    await iterator.return?.();
    await adapter.stop();
  });

  it("reconciles a missed terminal event through agent.wait and chat.history", async () => {
    const fake = new FakeOpenClawClient({ suppressEvents: true });
    const adapter = createAdapter(fake);
    await adapter.start();

    const events = [];
    for await (const event of adapter.run({ message: inbound })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text-delta", text: "OpenClaw" });
    expect(events.at(-1)).toEqual({
      type: "message-completed",
      text: "OpenClaw",
    });
    expect(fake.requests.map((request) => request.method)).toContain(
      "agent.wait",
    );
    await adapter.stop();
  });

  it("fails closed for a non-loopback Gateway", () => {
    expect(
      () =>
        new OpenClawRuntimeAdapter({
          url: "wss://gateway.example.com",
          token: "test-token",
        }),
    ).toThrow("only a loopback Gateway URL");
  });
});

function createAdapter(fake: FakeOpenClawClient) {
  return new OpenClawRuntimeAdapter({
    clientFactory: (handlers) => fake.attach(handlers),
    requestTimeoutMs: 1_000,
    runTimeoutMs: 2_000,
    connectTimeoutMs: 1_000,
  });
}

class FakeOpenClawClient implements OpenClawGatewayClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private handlers?: OpenClawClientHandlers;
  private held?: { runId: string; sessionKey: string };
  private readonly completedRuns = new Set<string>();
  private readonly runWaiters = new Map<string, Array<() => void>>();
  private readonly messagesBySession = new Map<string, unknown[]>();

  constructor(
    private readonly options: {
      holdRuns?: boolean;
      suppressEvents?: boolean;
    } = {},
  ) {}

  attach(handlers: OpenClawClientHandlers): this {
    this.handlers = handlers;
    return this;
  }

  start(): void {
    queueMicrotask(() => this.handlers!.onHello());
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "health") return { ok: true } as T;
    if (method === "chat.history") {
      const sessionKey = (params as { sessionKey: string }).sessionKey;
      return { messages: this.messagesBySession.get(sessionKey) ?? [] } as T;
    }
    if (method === "agent.wait") {
      const runId = (params as { runId: string }).runId;
      if (!this.completedRuns.has(runId)) {
        await new Promise<void>((resolve) => {
          const waiters = this.runWaiters.get(runId) ?? [];
          waiters.push(resolve);
          this.runWaiters.set(runId, waiters);
        });
      }
      return { status: "ok" } as T;
    }
    if (method === "chat.abort") return { aborted: true } as T;
    if (method !== "chat.send") return {} as T;
    const send = params as {
      idempotencyKey: string;
      sessionKey: string;
    };
    if (this.options.holdRuns) {
      this.held = { runId: send.idempotencyKey, sessionKey: send.sessionKey };
    } else {
      queueMicrotask(() =>
        this.completeTurn(send.idempotencyKey, send.sessionKey),
      );
    }
    return { runId: send.idempotencyKey, status: "started" } as T;
  }

  finishHeldRun(): void {
    if (!this.held) return;
    this.completeTurn(this.held.runId, this.held.sessionKey);
    this.held = undefined;
  }

  stop(): void {}

  private completeTurn(runId: string, sessionKey: string): void {
    this.messagesBySession.set(sessionKey, [
      {
        role: "assistant",
        content: [{ type: "text", text: "OpenClaw" }],
      },
    ]);
    if (!this.options.suppressEvents) this.emitTurn(runId, sessionKey);
    this.completedRuns.add(runId);
    for (const resolve of this.runWaiters.get(runId) ?? []) resolve();
    this.runWaiters.delete(runId);
  }

  private emitTurn(runId: string, sessionKey: string): void {
    this.handlers!.onEvent({
      event: "chat",
      payload: {
        runId,
        sessionKey,
        seq: 0,
        state: "status",
        phase: "starting_model",
      },
    });
    this.handlers!.onEvent({
      event: "chat",
      payload: {
        runId,
        sessionKey,
        seq: 1,
        state: "delta",
        deltaText: "Open",
      },
    });
    this.handlers!.onEvent({
      event: "chat",
      payload: {
        runId,
        sessionKey,
        seq: 2,
        state: "delta",
        deltaText: "Claw",
      },
    });
    this.handlers!.onEvent({
      event: "chat",
      payload: {
        runId,
        sessionKey,
        seq: 3,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OpenClaw" }],
        },
      },
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
