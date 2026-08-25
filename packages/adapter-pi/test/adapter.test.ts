import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  PooledPiRuntimeAdapter,
  PiRuntimeAdapter,
  StrictJsonlDecoder,
  type PiRpcClient,
  type PiRpcClientHandlers,
  type PiRpcResponse,
} from "../src/index.js";
import { exerciseTextRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";
import type {
  AgentRunEvent,
  AgentRuntimeAdapter,
  InboundMessage,
  RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

describe("PiRuntimeAdapter", () => {
  it("satisfies the shared text and resume contract", async () => {
    const fake = new FakePiClient();
    const adapter = createAdapter(fake);
    await adapter.start();

    const transcript = await exerciseTextRuntimeContract(
      adapter,
      message([{ type: "text", text: "hello" }]),
    );

    expect(transcript.first.at(-1)).toEqual({
      type: "message-completed",
      text: "reply-1",
    });
    expect(transcript.resumed.at(-1)).toEqual({
      type: "message-completed",
      text: "reply-2",
    });
    expect(
      fake.commands.filter((command) => command.type === "new_session"),
    ).toHaveLength(1);
    await adapter.stop();
  });

  it("restores an opaque session through switch_session after restart", async () => {
    const first = new FakePiClient();
    const adapter = createAdapter(first);
    await adapter.start();
    const firstEvents = await collect(
      adapter.run({ message: message([{ type: "text", text: "one" }]) }),
    );
    const sessionId = firstEvents.find(
      (event) => event.type === "session-started",
    );
    expect(sessionId?.type).toBe("session-started");
    await adapter.stop();

    const restarted = new FakePiClient();
    const resumed = createAdapter(restarted);
    await resumed.start();
    await collect(
      resumed.run({
        message: message([{ type: "text", text: "two" }]),
        sessionId:
          sessionId?.type === "session-started" ? sessionId.sessionId : "",
      }),
    );
    expect(
      restarted.commands.find((command) => command.type === "switch_session"),
    ).toMatchObject({
      type: "switch_session",
      sessionPath: "/sessions/session-1.jsonl",
    });
    await resumed.stop();
  });

  it("replaces a failed RPC client before the next run", async () => {
    const first = new FakePiClient();
    const second = new FakePiClient();
    const clients = [first, second];
    const adapter = new PiRuntimeAdapter({
      clientFactory: (handlers) => {
        const client = clients.shift();
        if (!client) throw new Error("unexpected extra Pi client");
        return client.attach(handlers);
      },
    });
    await adapter.start();
    first.fail(new Error("simulated Pi process exit"));
    expect(await adapter.health()).toMatchObject({ ok: false });

    const events = await collect(
      adapter.run({ message: message([{ type: "text", text: "recover" }]) }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "message-completed",
      text: "reply-1",
    });
    expect(clients).toHaveLength(0);
    await adapter.stop();
  });

  it("maps protected local images to Pi base64 image content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-adapter-test-"));
    const path = join(directory, "pixel.png");
    await writeFile(path, Buffer.from([0, 1, 2, 3]));
    try {
      const fake = new FakePiClient();
      const adapter = createAdapter(fake);
      await adapter.start();
      expect(adapter.inputModalities).toEqual(new Set(["image"]));
      await collect(
        adapter.run({
          message: message([
            { type: "text", text: "inspect" },
            { type: "image", path, mimeType: "image/png" },
          ]),
        }),
      );
      expect(
        fake.commands.find((command) => command.type === "prompt"),
      ).toMatchObject({
        message: "inspect",
        images: [
          {
            type: "image",
            data: Buffer.from([0, 1, 2, 3]).toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
      await adapter.stop();
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("uses non-semantic protocol padding for image-only prompts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-adapter-test-"));
    const path = join(directory, "pixel.png");
    await writeFile(path, Buffer.from([0, 1, 2, 3]));
    try {
      const fake = new FakePiClient();
      const adapter = createAdapter(fake);
      await adapter.start();
      await collect(
        adapter.run({
          message: message([{ type: "image", path, mimeType: "image/png" }]),
        }),
      );
      expect(
        fake.commands.find((command) => command.type === "prompt"),
      ).toMatchObject({
        message: " ",
        images: [
          {
            type: "image",
            data: Buffer.from([0, 1, 2, 3]).toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
      await adapter.stop();
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("does not advertise or accept images for a text-only Pi model", async () => {
    const fake = new FakePiClient({ modelInput: ["text"] });
    const adapter = createAdapter(fake);
    await adapter.start();
    expect(adapter.capabilities.has("multimodal-input")).toBe(false);
    expect(adapter.inputModalities).toEqual(new Set());
    const events = await collect(
      adapter.run({
        message: message([
          {
            type: "image",
            path: "/private/image.png",
            mimeType: "image/png",
          },
        ]),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      message: "Configured Pi model cannot accept image input",
    });
    await adapter.stop();
  });

  it("fails unsupported modalities instead of creating text placeholders", async () => {
    const fake = new FakePiClient();
    const adapter = createAdapter(fake);
    await adapter.start();
    const events = await collect(
      adapter.run({
        message: message([{ type: "file", path: "/private/report.pdf" }]),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      message: expect.stringContaining("cannot accept file input"),
    });
    expect(fake.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );
    await adapter.stop();
  });

  it("routes cancel only to the matching active Pi session", async () => {
    const fake = new FakePiClient({ settlePrompts: false });
    const adapter = createAdapter(fake);
    await adapter.start();
    const iterator = adapter
      .run({ message: message([{ type: "text", text: "wait" }]) })
      [Symbol.asyncIterator]();
    const started = await iterator.next();
    expect(started.value?.type).toBe("session-started");
    await iterator.next();
    const eventPromise = iterator.next();
    await fake.waitForPrompt();
    const opaque =
      started.value?.type === "session-started" ? started.value.sessionId : "";
    await adapter.cancel("another-session");
    expect(fake.commands.some((command) => command.type === "abort")).toBe(
      false,
    );
    await adapter.cancel(opaque);
    expect(fake.commands.some((command) => command.type === "abort")).toBe(
      true,
    );
    fake.lastText = "cancelled";
    fake.emit({ type: "agent_settled" });
    await eventPromise;
    await iterator.next();
    await adapter.stop();
  });

  it("fails closed on Pi-timed dialogs to avoid competing TTL owners", async () => {
    const fake = new FakePiClient({ extensionDialog: true });
    const adapter = createAdapter(fake);
    await adapter.start();
    await collect(
      adapter.run({ message: message([{ type: "text", text: "hello" }]) }),
    );
    expect(fake.sent).toContainEqual({
      type: "extension_ui_response",
      id: "dialog-1",
      cancelled: true,
    });
    await adapter.stop();
  });

  it("bridges a live Pi confirm dialog without creating a synthetic prompt", async () => {
    const fake = new FakePiClient({ settlePrompts: false });
    const adapter = createAdapter(fake);
    await adapter.start();
    expect(adapter.capabilities.has("interaction-resume")).toBe(true);
    expect(adapter.capabilities.has("interaction-live-resume")).toBe(true);
    const iterator = adapter
      .run({ message: message([{ type: "text", text: "hello" }]) })
      [Symbol.asyncIterator]();
    const started = await iterator.next();
    expect(started.value?.type).toBe("session-started");
    expect((await iterator.next()).value).toMatchObject({
      type: "status",
      phase: "accepted",
    });
    const thinking = iterator.next();
    await fake.waitForPrompt();
    expect((await thinking).value).toMatchObject({
      type: "status",
      phase: "thinking",
    });
    fake.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "继续执行？",
      message: "请确认下一步。",
    });
    expect((await iterator.next()).value).toEqual({
      type: "interaction-requested",
      request: {
        kind: "confirm",
        title: "继续执行？",
        description: "请确认下一步。",
      },
    });
    const sessionId =
      started.value?.type === "session-started" ? started.value.sessionId : "";
    await collect(
      adapter.resumeInteraction!({
        sessionId,
        idempotencyKey: "interaction-resume:test-confirm",
        result: {
          interactionId: "interaction-test-confirm",
          status: "submitted",
          values: { confirmation: ["confirmed"] },
          submittedAt: "2026-08-25T00:00:00.000Z",
        },
      }),
    );
    expect(fake.sent).toContainEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: true,
    });
    expect(
      fake.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);

    fake.lastText = "已确认并继续";
    fake.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: fake.lastText,
      },
    });
    fake.emit({ type: "agent_settled" });
    expect((await iterator.next()).value).toEqual({
      type: "text-delta",
      text: "已确认并继续",
    });
    expect((await iterator.next()).value).toEqual({
      type: "message-completed",
      text: "已确认并继续",
    });
    expect((await iterator.next()).done).toBe(true);
    await adapter.stop();
  });

  it("maps Pi select and input dialogs to neutral interaction semantics", async () => {
    const select = new FakePiClient({ settlePrompts: false });
    const selectAdapter = createAdapter(select);
    await selectAdapter.start();
    const selectIterator = selectAdapter
      .run({ message: message([{ type: "text", text: "choose" }]) })
      [Symbol.asyncIterator]();
    const selectStarted = await selectIterator.next();
    await selectIterator.next();
    const selectThinking = selectIterator.next();
    await select.waitForPrompt();
    await selectThinking;
    select.emit({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "选择环境",
      options: ["生产", "测试"],
    });
    expect((await selectIterator.next()).value).toMatchObject({
      type: "interaction-requested",
      request: {
        kind: "single-select",
        fieldId: "selection",
        options: [
          { value: "pi-option-0", label: "生产" },
          { value: "pi-option-1", label: "测试" },
        ],
      },
    });
    const selectSession =
      selectStarted.value?.type === "session-started"
        ? selectStarted.value.sessionId
        : "";
    await collect(
      selectAdapter.resumeInteraction!({
        sessionId: selectSession,
        idempotencyKey: "interaction-resume:test-select",
        result: {
          interactionId: "interaction-test-select",
          status: "submitted",
          values: { selection: ["pi-option-1"] },
          submittedAt: "2026-08-25T00:00:00.000Z",
        },
      }),
    );
    expect(select.sent).toContainEqual({
      type: "extension_ui_response",
      id: "select-1",
      value: "测试",
    });
    await selectIterator.return?.();
    await selectAdapter.stop();

    const input = new FakePiClient({ settlePrompts: false });
    const inputAdapter = createAdapter(input);
    await inputAdapter.start();
    const inputIterator = inputAdapter
      .run({ message: message([{ type: "text", text: "input" }]) })
      [Symbol.asyncIterator]();
    await inputIterator.next();
    await inputIterator.next();
    const inputThinking = inputIterator.next();
    await input.waitForPrompt();
    await inputThinking;
    input.emit({
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "请输入名称",
      placeholder: "项目名称",
    });
    expect((await inputIterator.next()).value).toEqual({
      type: "interaction-requested",
      request: {
        kind: "text-input",
        title: "请输入名称",
        fieldId: "value",
        placeholder: "项目名称",
        multiline: false,
      },
    });
    await inputIterator.return?.();
    expect(input.sent).toContainEqual({
      type: "extension_ui_response",
      id: "input-1",
      cancelled: true,
    });
    await inputAdapter.stop();
  });

  it("rejects session handles outside Pi's inferred storage root", async () => {
    const fake = new FakePiClient();
    const adapter = createAdapter(fake);
    await adapter.start();
    const forged = `pi-rpc-v1:${Buffer.from(
      JSON.stringify({
        sessionFile: "/outside/session.jsonl",
        sessionId: "forged",
      }),
    ).toString("base64url")}`;
    const events = await collect(
      adapter.run({
        message: message([{ type: "text", text: "hello" }]),
        sessionId: forged,
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "failed",
        message: "Pi session is outside configured storage roots",
      }),
    ]);
    expect(
      fake.commands.some((command) => command.type === "switch_session"),
    ).toBe(false);
    await adapter.stop();
  });
});

describe("PooledPiRuntimeAdapter", () => {
  it("runs unrelated sessions concurrently within the worker bound", async () => {
    const tracker = new PoolTracker();
    const adapter = new PooledPiRuntimeAdapter({
      maxWorkers: 2,
      workerFactory: () => new FakePoolWorker(tracker),
    });
    await adapter.start();

    const first = collect(
      adapter.run({
        message: message([{ type: "text", text: "one" }]),
        sessionId: "session-a",
      }),
    );
    const second = collect(
      adapter.run({
        message: message([{ type: "text", text: "two" }]),
        sessionId: "session-b",
      }),
    );
    await tracker.waitForStarted(2);
    expect(tracker.maxActive).toBe(2);
    tracker.releaseAll();
    await Promise.all([first, second]);
    expect(await adapter.health()).toMatchObject({ ok: true });
    await adapter.stop();
  });

  it("serializes duplicate runs for the same session", async () => {
    const tracker = new PoolTracker();
    const adapter = new PooledPiRuntimeAdapter({
      maxWorkers: 2,
      workerFactory: () => new FakePoolWorker(tracker),
    });
    await adapter.start();

    const first = collect(
      adapter.run({
        message: message([{ type: "text", text: "one" }]),
        sessionId: "same-session",
      }),
    );
    const second = collect(
      adapter.run({
        message: message([{ type: "text", text: "two" }]),
        sessionId: "same-session",
      }),
    );
    await tracker.waitForStarted(1);
    await Promise.resolve();
    expect(tracker.started).toBe(1);
    tracker.releaseNext();
    await tracker.waitForStarted(2);
    expect(tracker.maxActive).toBe(1);
    tracker.releaseNext();
    await Promise.all([first, second]);
    await adapter.stop();
  });

  it("routes live interaction responses to the worker holding the session", async () => {
    const tracker = new PoolTracker();
    const adapter = new PooledPiRuntimeAdapter({
      maxWorkers: 1,
      workerFactory: () => new FakePoolWorker(tracker),
    });
    await adapter.start();
    const run = collect(
      adapter.run({
        message: message([{ type: "text", text: "one" }]),
        sessionId: "session-a",
      }),
    );
    await tracker.waitForStarted(1);
    await collect(
      adapter.resumeInteraction!({
        sessionId: "session-a",
        idempotencyKey: "interaction-resume:pool",
        result: {
          interactionId: "interaction-pool",
          status: "submitted",
          values: { confirmation: ["confirmed"] },
          submittedAt: "2026-08-25T00:00:00.000Z",
        },
      }),
    );
    await run;
    expect(tracker.resumes).toEqual(["interaction-resume:pool"]);
    await adapter.stop();
  });
});

describe("StrictJsonlDecoder", () => {
  it("splits only on LF and preserves Unicode line separators", () => {
    const lines: string[] = [];
    const errors: Error[] = [];
    const decoder = new StrictJsonlDecoder(
      (line) => lines.push(line),
      (error) => errors.push(error),
    );
    const first = '{"text":"before\u2028after\u2029done"}\r\n';
    const bytes = Buffer.from(first, "utf8");
    decoder.push(bytes.subarray(0, 12));
    decoder.push(bytes.subarray(12));
    decoder.end();
    expect(lines).toEqual(['{"text":"before\u2028after\u2029done"}']);
    expect(JSON.parse(lines[0]).text).toBe("before\u2028after\u2029done");
    expect(errors).toEqual([]);
  });

  it("rejects an unbounded record without LF framing", () => {
    const errors: Error[] = [];
    const decoder = new StrictJsonlDecoder(
      () => undefined,
      (error) => errors.push(error),
    );
    decoder.push(Buffer.alloc(8 * 1024 * 1024 + 1, "x"));
    expect(errors).toEqual([
      expect.objectContaining({
        message: "Pi RPC JSONL record exceeds the size limit",
      }),
    ]);
  });
});

interface FakeOptions {
  settlePrompts?: boolean;
  extensionDialog?: boolean;
  modelInput?: string[];
}

class PoolTracker {
  active = 0;
  maxActive = 0;
  started = 0;
  readonly releases: Array<() => void> = [];
  readonly resumes: string[] = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];

  entered(): Promise<void> {
    this.active += 1;
    this.started += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (this.started >= waiter.count) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
    return new Promise((resolveRelease) => {
      this.releases.push(() => {
        this.active -= 1;
        resolveRelease();
      });
    });
  }

  waitForStarted(count: number): Promise<void> {
    if (this.started >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  releaseNext(): void {
    this.releases.shift()?.();
  }

  releaseAll(): void {
    for (const release of this.releases.splice(0)) release();
  }
}

class FakePoolWorker implements AgentRuntimeAdapter {
  readonly id = "pi";
  readonly contractVersion = 1;
  readonly sessionCompatibilityId = "pi:rpc-v1";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
    "cancel",
    "status-events",
    "multimodal-input",
    "interaction-resume",
    "interaction-live-resume",
  ]);
  readonly inputModalities = new Set(["image" as const]);

  constructor(private readonly tracker: PoolTracker) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async *run(): AsyncIterable<AgentRunEvent> {
    await this.tracker.entered();
    yield { type: "message-completed", text: "ok" };
  }
  async *resumeInteraction(
    request: Parameters<
      NonNullable<AgentRuntimeAdapter["resumeInteraction"]>
    >[0],
  ): AsyncIterable<AgentRunEvent> {
    this.tracker.resumes.push(request.idempotencyKey);
    this.tracker.releaseNext();
  }
  async cancel(): Promise<void> {}
}

class FakePiClient implements PiRpcClient {
  readonly commands: Record<string, unknown>[] = [];
  readonly sent: Record<string, unknown>[] = [];
  lastText = "";
  private handlers?: PiRpcClientHandlers;
  private session = { sessionFile: "/sessions/boot.jsonl", sessionId: "boot" };
  private promptCount = 0;
  private promptWaiters: Array<() => void> = [];

  constructor(private readonly options: FakeOptions = {}) {}

  attach(handlers: PiRpcClientHandlers): this {
    this.handlers = handlers;
    return this;
  }

  async start(): Promise<void> {}

  async request<T = unknown>(
    command: Record<string, unknown>,
  ): Promise<PiRpcResponse<T>> {
    this.commands.push(command);
    const type = String(command.type);
    if (type === "get_state") {
      return ok(type, {
        ...this.session,
        model: { input: this.options.modelInput ?? ["text", "image"] },
      }) as PiRpcResponse<T>;
    }
    if (type === "new_session") {
      this.session = {
        sessionFile: "/sessions/session-1.jsonl",
        sessionId: "session-1",
      };
      return ok(type, { cancelled: false }) as PiRpcResponse<T>;
    }
    if (type === "switch_session") {
      const path = String(command.sessionPath);
      this.session = {
        sessionFile: path,
        sessionId: path.includes("session-1") ? "session-1" : "unknown",
      };
      return ok(type, { cancelled: false }) as PiRpcResponse<T>;
    }
    if (type === "prompt") {
      this.promptCount += 1;
      this.lastText = `reply-${this.promptCount}`;
      for (const waiter of this.promptWaiters.splice(0)) waiter();
      queueMicrotask(() => {
        this.emit({ type: "agent_start" });
        if (this.options.extensionDialog) {
          this.emit({
            type: "extension_ui_request",
            id: "dialog-1",
            method: "confirm",
            title: "Timed confirmation",
            message: "Pi owns this timeout",
            timeout: 10_000,
          });
        }
        if (this.options.settlePrompts !== false) {
          this.emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: this.lastText,
            },
          });
          this.emit({ type: "agent_settled" });
        }
      });
      return ok(type) as PiRpcResponse<T>;
    }
    if (type === "get_last_assistant_text") {
      return ok(type, { text: this.lastText }) as PiRpcResponse<T>;
    }
    return ok(type) as PiRpcResponse<T>;
  }

  async send(command: Record<string, unknown>): Promise<void> {
    this.sent.push(command);
  }

  async stop(): Promise<void> {}

  emit(event: Record<string, unknown>): void {
    this.handlers?.onEvent(event);
  }

  fail(error: Error): void {
    this.handlers?.onError(error);
  }

  waitForPrompt(): Promise<void> {
    if (this.promptCount > 0) return Promise.resolve();
    return new Promise((resolveWait) => this.promptWaiters.push(resolveWait));
  }
}

function createAdapter(fake: FakePiClient): PiRuntimeAdapter {
  return new PiRuntimeAdapter({
    clientFactory: (handlers) => fake.attach(handlers),
  });
}

function ok(command: string, data?: unknown): PiRpcResponse {
  return { type: "response", command, success: true, data };
}

function message(parts: InboundMessage["parts"]): InboundMessage {
  return {
    id: "message-1",
    accountId: "account-1",
    conversationId: "conversation-1",
    conversationType: "direct",
    senderId: "sender-1",
    receivedAt: "2026-08-24T00:00:00.000Z",
    parts,
  };
}

async function collect(
  iterable: AsyncIterable<AgentRunEvent>,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
