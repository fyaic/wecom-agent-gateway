import { describe, expect, it } from "vitest";
import type {
  AgentRunEvent,
  AgentRunRequest,
  AgentRuntimeAdapter,
  AgentMediaOutput,
  ChannelCapability,
  ChannelEnterChatEvent,
  ChannelFeedbackEvent,
  ChannelTransport,
  DeliveryOutboxStats,
  DeliveryReceipt,
  DurableMediaArtifact,
  InboundMessage,
  MaterializedInboundMessage,
  MediaType,
  MediaSpool,
  OutboundCommand,
  RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";
import {
  AllowlistPolicy,
  MemoryGatewayStore,
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "../src/index.js";

class FakeTransport implements ChannelTransport {
  readonly id = "fake-wecom";
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    "stream-reply-update",
    "proactive-message",
  ]);
  readonly commands: OutboundCommand[] = [];
  private handler?: (message: InboundMessage) => Promise<void>;
  private feedbackHandler?: (event: ChannelFeedbackEvent) => Promise<void>;
  private enterChatHandler?: (event: ChannelEnterChatEvent) => Promise<boolean>;
  async start(
    handler: (message: InboundMessage) => Promise<void>,
    feedbackHandler?: (event: ChannelFeedbackEvent) => Promise<void>,
    enterChatHandler?: (event: ChannelEnterChatEvent) => Promise<boolean>,
  ): Promise<void> {
    this.handler = handler;
    this.feedbackHandler = feedbackHandler;
    this.enterChatHandler = enterChatHandler;
  }
  async stop(): Promise<void> {}
  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    this.commands.push(command);
    return {
      id: `delivery-${this.commands.length}`,
      acceptedAt: new Date().toISOString(),
    };
  }
  async receive(message: InboundMessage): Promise<void> {
    if (!this.handler) throw new Error("transport not started");
    await this.handler(message);
  }
  async receiveFeedback(event: ChannelFeedbackEvent): Promise<void> {
    if (!this.feedbackHandler) throw new Error("feedback handler not started");
    await this.feedbackHandler(event);
  }
  async receiveEnterChat(event: ChannelEnterChatEvent): Promise<boolean> {
    if (!this.enterChatHandler)
      throw new Error("enter-chat handler not started");
    return this.enterChatHandler(event);
  }
}

class FakeRuntime implements AgentRuntimeAdapter {
  readonly id = "fake-runtime";
  readonly contractVersion = 1;
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
  ]);
  readonly requests: AgentRunRequest[] = [];
  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    this.requests.push(request);
    yield {
      type: "session-started",
      sessionId: request.sessionId ?? "session-1",
    };
    yield { type: "text-delta", text: "你" };
    yield { type: "text-delta", text: "好" };
    yield { type: "message-completed" };
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

class FakeMediaSpool implements MediaSpool {
  readonly id = "fake-media-spool";
  readonly released: string[] = [];
  private readonly artifacts = new Map<string, AgentMediaOutput>();
  private nextId = 1;

  async stage(media: AgentMediaOutput): Promise<DurableMediaArtifact> {
    const artifactId = `artifact-${this.nextId++}`;
    this.artifacts.set(artifactId, media);
    return {
      artifactId,
      type: media.type,
      name: media.name,
      mimeType: media.mimeType,
      title: media.title,
      description: media.description,
      sizeBytes: 6,
      sha256: "fake-sha256",
    };
  }

  async materialize(artifact: DurableMediaArtifact): Promise<AgentMediaOutput> {
    const media = this.artifacts.get(artifact.artifactId);
    if (!media) throw new Error("artifact missing");
    return {
      ...media,
      path: `/spool/${artifact.artifactId}/data`,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    };
  }

  async release(artifactId: string): Promise<void> {
    this.released.push(artifactId);
    this.artifacts.delete(artifactId);
  }

  async reconcile(): Promise<void> {}
}

const message = (id: string): InboundMessage => ({
  id,
  accountId: "bot-a",
  conversationId: "chat-a",
  conversationType: "direct",
  senderId: "user-a",
  receivedAt: "2026-08-20T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
  replyReference: { requestId: `req-${id}` },
});

describe("WeComAgentGateway", () => {
  it("observes channel feedback without creating an Agent turn", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const observed: ChannelFeedbackEvent[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onChannelFeedbackEvent: (event) => observed.push(event),
    });
    await gateway.start();
    const feedback: ChannelFeedbackEvent = {
      id: "feedback-1",
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      receivedAt: "2026-08-28T00:00:00.000Z",
      feedbackId: "stream-1",
    };
    await transport.receiveFeedback(feedback);

    expect(observed).toEqual([feedback]);
    expect(runtime.requests).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
  });

  it("applies the scoped inbound policy to feedback and enter-chat events", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const observed: ChannelFeedbackEvent[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      policy: new AllowlistPolicy({ allowedDirectSenders: ["allowed-user"] }),
      onChannelFeedbackEvent: (event) => observed.push(event),
    });
    await gateway.start();
    const unauthorized = {
      id: "event-unauthorized",
      accountId: "bot-a",
      conversationId: "other-user",
      conversationType: "direct" as const,
      senderId: "other-user",
      receivedAt: "2026-08-28T00:00:00.000Z",
    };
    await transport.receiveFeedback({
      ...unauthorized,
      feedbackId: "stream-1",
    });
    expect(await transport.receiveEnterChat(unauthorized)).toBe(false);

    const authorized = {
      ...unauthorized,
      id: "event-authorized",
      conversationId: "allowed-user",
      senderId: "allowed-user",
    };
    await transport.receiveFeedback({ ...authorized, feedbackId: "stream-2" });
    expect(await transport.receiveEnterChat(authorized)).toBe(true);
    expect(observed).toEqual([
      expect.objectContaining({ senderId: "allowed-user" }),
    ]);
    expect(runtime.requests).toHaveLength(0);
  });

  it("projects status events into mutable text without an ephemeral first-frame card", async () => {
    class ProgressTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
      ]);
    }
    const transport = new ProgressTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "status-runtime",
      contractVersion: 1,
      capabilities: new Set(["streaming", "status-events"]),
      async *run() {
        yield { type: "session-started", sessionId: "status-session" };
        yield { type: "status", phase: "thinking" };
        await new Promise((resolve) => setTimeout(resolve, 3));
        yield {
          type: "status",
          phase: "custom",
          emoji: "🔎",
          text: "正在核对一段非常长但只应安全显示在卡片标题范围内的资料",
        };
        await new Promise((resolve) => setTimeout(resolve, 3));
        yield { type: "text-delta", text: "已完成核对" };
        await new Promise((resolve) => setTimeout(resolve, 3));
        yield { type: "message-completed" };
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyUpdateIntervalMs: 1,
      outboxPollIntervalMs: 1,
    });

    await gateway.start();
    await transport.receive(message("progress-run"));

    const replies = transport.commands.filter(
      (command) => command.type === "reply",
    );
    expect(replies[0]).toMatchObject({ final: false });
    expect(replies[0]).not.toHaveProperty("presentation");
    expect(
      replies.some(
        (command) => command.type === "reply" && command.text.startsWith("🔎"),
      ),
    ).toBe(true);
    expect(replies.at(-1)).toMatchObject({
      text: "已完成核对",
      final: true,
    });
    expect(replies.at(-1)).not.toHaveProperty("presentation");
    expect(
      transport.commands.filter(
        (command) => command.type === "proactive-presentation",
      ),
    ).toHaveLength(0);
    await gateway.stop();
  });

  it("offers one proactive scoped cancel card even when combined streams are available", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
        "reply-with-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    let releaseRun!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const cancelledSessions: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "cancellable-runtime",
      contractVersion: 1,
      capabilities: new Set(["streaming", "cancel"]),
      async *run() {
        yield { type: "session-started", sessionId: "session-cancel" };
        yield { type: "status", phase: "thinking" };
        await released;
      },
      async cancel(sessionId) {
        cancelledSessions.push(sessionId);
        releaseRun();
      },
      async health() {
        return { ok: true };
      },
    };
    const lifecycle: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      replyUpdateIntervalMs: 1,
      runControlAfterMs: 1,
      runControlTimeoutMs: 10_000,
      onInteractionLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();
    const original = transport.receive(message("long-run"));
    await waitFor(
      () =>
        transport.commands.filter(
          (command) => command.type === "proactive-presentation",
        ).length === 1,
    );
    const card = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    if (!card || card.type !== "proactive-presentation") {
      throw new Error("run control card was not delivered");
    }
    expect(card.presentation).toMatchObject({
      kind: "actions",
      title: "⏳ 本轮任务仍在执行",
      actions: [{ id: "cancel", label: "停止本轮", style: "danger" }],
    });
    expect(
      transport.commands.some(
        (command) => command.type === "reply" && command.presentation,
      ),
    ).toBe(false);

    await transport.receive({
      ...message("wrong-run-controller"),
      senderId: "other-user",
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "cancel",
      },
    });
    expect(cancelledSessions).toEqual([]);

    await transport.receive({
      ...message("cancel-long-run"),
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "cancel",
      },
    });
    await original;
    expect(cancelledSessions).toEqual(["session-cancel"]);
    expect(lifecycle).toEqual(["requested", "cancelled"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "interaction-update",
        presentation: expect.objectContaining({
          id: card.presentation.id,
          body: "⏹️ 正在停止当前任务。",
        }),
      }),
    );
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "⏹️ 任务已停止。",
      final: true,
    });

    const updateCount = transport.commands.filter(
      (command) => command.type === "interaction-update",
    ).length;
    await transport.receive({
      ...message("duplicate-cancel-long-run"),
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "cancel",
      },
    });
    expect(cancelledSessions).toHaveLength(1);
    expect(
      transport.commands.filter(
        (command) => command.type === "interaction-update",
      ),
    ).toHaveLength(updateCount);
    await gateway.stop();
  });

  it("does not show run controls for fast or non-cancellable runs", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    const runtime = new FakeRuntime();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      runControlAfterMs: 1,
    });
    await gateway.start();
    await transport.receive(message("no-run-control"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      transport.commands.filter(
        (command) => command.type === "proactive-presentation",
      ),
    ).toHaveLength(0);
    await gateway.stop();
  });

  it("cannot use a completed control card to cancel a later run", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let cancellations = 0;
    const runtime: AgentRuntimeAdapter = {
      id: "completed-control-runtime",
      contractVersion: 1,
      capabilities: new Set(["cancel"]),
      async *run() {
        yield { type: "session-started", sessionId: "shared-session" };
        await gate;
        yield { type: "message-completed", text: "正常完成" };
      },
      async cancel() {
        cancellations += 1;
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      runControlAfterMs: 1,
    });
    await gateway.start();
    const original = transport.receive(message("naturally-completed-run"));
    await waitFor(() =>
      transport.commands.some(
        (command) => command.type === "proactive-presentation",
      ),
    );
    const card = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    if (!card || card.type !== "proactive-presentation") {
      throw new Error("completed run control card was not delivered");
    }
    finish();
    await original;
    const updatesBefore = transport.commands.filter(
      (command) => command.type === "interaction-update",
    ).length;
    await transport.receive({
      ...message("stale-run-control"),
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "cancel",
      },
    });
    expect(cancellations).toBe(0);
    const updates = transport.commands.filter(
      (command) => command.type === "interaction-update",
    );
    expect(updates).toHaveLength(updatesBefore + 1);
    expect(updates.at(-1)).toMatchObject({
      type: "interaction-update",
      presentation: { body: "任务已经结束，无需停止。" },
    });
    await transport.receive({
      ...message("duplicate-stale-run-control"),
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "cancel",
      },
    });
    expect(
      transport.commands.filter(
        (command) => command.type === "interaction-update",
      ),
    ).toHaveLength(updatesBefore + 1);
    await gateway.stop();
  });

  it("reports identifier-free operational readiness and aggregate work state", async () => {
    const gateway = new WeComAgentGateway({
      transport: new FakeTransport(),
      adapters: [new FakeRuntime()],
      router: new StaticRuntimeRouter("fake-runtime"),
      store: new MemoryGatewayStore(),
    });

    await expect(gateway.operationalSnapshot()).resolves.toMatchObject({
      state: "stopped",
      ready: false,
      transportHealthy: false,
      adapters: { total: 1, healthy: 0 },
      storeHealthy: true,
      work: {
        pendingInboundMessages: 0,
        activeRuns: 0,
        pendingApprovals: 0,
      },
      outbox: { pending: 0, leased: 0, delivered: 0, dead: 0 },
    });

    await gateway.start();
    const running = await gateway.operationalSnapshot();
    expect(running).toMatchObject({ state: "running", ready: true });
    expect(JSON.stringify(running)).not.toContain("bot-a");
    await gateway.stop();
    await expect(gateway.operationalSnapshot()).resolves.toMatchObject({
      state: "stopped",
      ready: false,
    });
  });

  it("fails readiness closed when aggregate store health cannot be read", async () => {
    class UnhealthyStore extends MemoryGatewayStore {
      override async getDeliveryOutboxStats(): Promise<DeliveryOutboxStats> {
        throw new Error("private storage failure");
      }
    }
    const gateway = new WeComAgentGateway({
      transport: new FakeTransport(),
      adapters: [new FakeRuntime()],
      router: new StaticRuntimeRouter("fake-runtime"),
      store: new UnhealthyStore(),
    });
    await gateway.start();
    await expect(gateway.operationalSnapshot()).resolves.toMatchObject({
      state: "running",
      ready: false,
      storeHealthy: false,
      outbox: { pending: 0, delivered: 0, dead: 0 },
    });
    await gateway.stop();
  });

  it("persists and delivers Gateway-native proactive text", async () => {
    const transport = new FakeTransport();
    const store = new MemoryGatewayStore();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [new FakeRuntime()],
      router: new StaticRuntimeRouter("fake-runtime"),
      store,
    });

    await expect(
      gateway.sendProactiveText({
        accountId: "bot-a",
        conversationId: "chat-a",
        text: "before start",
      }),
    ).rejects.toThrow("not accepting proactive commands");

    await gateway.start();
    const state = await gateway.sendProactiveText({
      accountId: "bot-a",
      conversationId: "chat-a",
      text: "主动通知",
    });
    await gateway.stop();

    expect(state).toBe("delivered");
    expect(transport.commands).toEqual([
      {
        type: "proactive",
        accountId: "bot-a",
        conversationId: "chat-a",
        text: "主动通知",
      },
    ]);
    expect(store.deliveries).toHaveLength(1);
    expect(await store.getDeliveryOutboxStats()).toMatchObject({
      delivered: 1,
      pending: 0,
      dead: 0,
    });
  });

  it("reports queued after a proactive send failure without losing the command", async () => {
    class FailingTransport extends FakeTransport {
      override async deliver(): Promise<DeliveryReceipt> {
        throw new Error("temporary proactive failure");
      }
    }
    const transport = new FailingTransport();
    const store = new MemoryGatewayStore();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [new FakeRuntime()],
      router: new StaticRuntimeRouter("fake-runtime"),
      store,
      outboxRetryBaseMs: 60_000,
    });
    await gateway.start();

    const state = await gateway.sendProactiveText({
      accountId: "bot-a",
      conversationId: "chat-a",
      text: "稍后重试",
    });
    await gateway.stop();

    expect(state).toBe("queued");
    expect(await store.getDeliveryOutboxStats()).toMatchObject({
      pending: 1,
      delivered: 0,
      dead: 0,
    });
  });

  it("spools and delivers Gateway-native proactive media", async () => {
    class ProactiveMediaTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "proactive-message",
        "media-upload",
        "multimodal-output",
      ]);
      readonly outputModalities: ReadonlySet<MediaType> = new Set(["image"]);
    }
    const transport = new ProactiveMediaTransport();
    const mediaSpool = new FakeMediaSpool();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [new FakeRuntime()],
      router: new StaticRuntimeRouter("fake-runtime"),
      store: new MemoryGatewayStore(),
      mediaSpool,
    });
    await gateway.start();

    const state = await gateway.sendProactiveMedia({
      accountId: "bot-a",
      conversationId: "chat-a",
      media: {
        type: "image",
        path: "/allowed/update.png",
        name: "update.png",
        mimeType: "image/png",
      },
    });

    await expect(
      gateway.sendProactiveMedia({
        accountId: "bot-a",
        conversationId: "chat-a",
        media: { type: "video", path: "/allowed/update.mp4" },
      }),
    ).rejects.toThrow("cannot deliver video output");
    await gateway.stop();

    expect(state).toBe("delivered");
    expect(transport.commands).toEqual([
      expect.objectContaining({
        type: "proactive-media",
        accountId: "bot-a",
        conversationId: "chat-a",
        media: expect.objectContaining({
          type: "image",
          path: "/spool/artifact-1/data",
        }),
      }),
    ]);
    expect(mediaSpool.released).toEqual(["artifact-1"]);
  });

  it("rejects an incompatible runtime contract before startup", () => {
    const runtime = {
      ...new FakeRuntime(),
      contractVersion: 2,
    } as unknown as AgentRuntimeAdapter;
    expect(
      () =>
        new WeComAgentGateway({
          transport: new FakeTransport(),
          adapters: [runtime],
          router: new StaticRuntimeRouter(runtime.id),
          store: new MemoryGatewayStore(),
        }),
    ).toThrow("does not support runtime contract v1");
  });

  it("rejects duplicate adapter ids before startup", () => {
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    expect(
      () =>
        new WeComAgentGateway({
          transport: new FakeTransport(),
          adapters: [first, second],
          router: new StaticRuntimeRouter(first.id),
          store: new MemoryGatewayStore(),
        }),
    ).toThrow("Adapter ids must be unique");
  });

  it("rejects an invalid adapter id before startup", () => {
    const runtime = {
      ...new FakeRuntime(),
      id: "user scoped adapter",
    } as unknown as AgentRuntimeAdapter;
    expect(
      () =>
        new WeComAgentGateway({
          transport: new FakeTransport(),
          adapters: [runtime],
          router: new StaticRuntimeRouter(runtime.id),
          store: new MemoryGatewayStore(),
        }),
    ).toThrow("stable non-empty identifier");
  });

  it("hosts adapter lifecycle outside semantic Agent turns", async () => {
    const lifecycle: string[] = [];
    class LifecycleTransport extends FakeTransport {
      override async start(
        handler: (message: InboundMessage) => Promise<void>,
      ): Promise<void> {
        lifecycle.push("transport-start");
        await super.start(handler);
      }
      override async stop(): Promise<void> {
        lifecycle.push("transport-stop");
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "lifecycle-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async start() {
        lifecycle.push("adapter-start");
      },
      async *run() {
        yield { type: "message-completed", text: "ok" };
      },
      async health() {
        return { ok: true };
      },
      async stop() {
        lifecycle.push("adapter-stop");
      },
    };
    const gateway = new WeComAgentGateway({
      transport: new LifecycleTransport(),
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });

    await gateway.start();
    await gateway.stop();
    expect(lifecycle).toEqual([
      "adapter-start",
      "transport-start",
      "transport-stop",
      "adapter-stop",
    ]);
  });

  it("does not open ingress when an adapter fails to start", async () => {
    const lifecycle: string[] = [];
    class LifecycleTransport extends FakeTransport {
      override async start(
        handler: (message: InboundMessage) => Promise<void>,
      ): Promise<void> {
        lifecycle.push("transport-start");
        await super.start(handler);
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "broken-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async start() {
        lifecycle.push("adapter-start");
        throw new Error("not ready");
      },
      async *run() {},
      async health() {
        return { ok: false };
      },
      async stop() {
        lifecycle.push("adapter-stop");
      },
    };
    const gateway = new WeComAgentGateway({
      transport: new LifecycleTransport(),
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });

    await expect(gateway.start()).rejects.toThrow("not ready");
    expect(lifecycle).toEqual(["adapter-start", "adapter-stop"]);
  });

  it("releases adapters even when transport shutdown reports an error", async () => {
    const lifecycle: string[] = [];
    class FailingStopTransport extends FakeTransport {
      override async stop(): Promise<void> {
        lifecycle.push("transport-stop");
        throw new Error("disconnect failed");
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "cleanup-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {},
      async health() {
        return { ok: true };
      },
      async stop() {
        lifecycle.push("adapter-stop");
      },
    };
    const errors: string[] = [];
    const gateway = new WeComAgentGateway({
      transport: new FailingStopTransport(),
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onInfrastructureError: (event) => errors.push(event.error.message),
    });

    await gateway.start();
    await gateway.stop();
    expect(lifecycle).toEqual(["transport-stop", "adapter-stop"]);
    expect(errors).toEqual(["disconnect failed"]);
  });

  it("streams a runtime response end to end and persists the session", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const store = new MemoryGatewayStore();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
    });
    await gateway.start();
    await transport.receive(message("m1"));
    await transport.receive(message("m2"));

    expect(
      transport.commands.map(
        (item) => item.type === "reply" && [item.text, item.final],
      ),
    ).toEqual([
      ["⏳ 已收到，等待 Agent 响应…", false],
      ["你好", true],
      ["⏳ 已收到，等待 Agent 响应…", false],
      ["你好", true],
    ]);
    expect(runtime.requests[1]?.sessionId).toBe("session-1");
    expect(store.deliveries).toHaveLength(4);
  });

  it("keeps the Agent run moving and retries only the newest stream state", async () => {
    class RecoveringTransport extends FakeTransport {
      readonly attempts: OutboundCommand[] = [];
      private failuresRemaining = 2;

      override async deliver(
        command: OutboundCommand,
      ): Promise<DeliveryReceipt> {
        this.attempts.push(command);
        if (this.failuresRemaining-- > 0) {
          throw new Error("temporary transport failure");
        }
        return super.deliver(command);
      }
    }
    const transport = new RecoveringTransport();
    const runtime = new FakeRuntime();
    const store = new MemoryGatewayStore();
    const deliveryEvents: unknown[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      outboxPollIntervalMs: 2,
      outboxRetryBaseMs: 2,
      onDeliveryLifecycleEvent: (event) => deliveryEvents.push(event),
    });
    await gateway.start();
    await transport.receive(message("recovering"));
    await waitFor(() => transport.commands.length === 1);
    await gateway.stop();

    expect(runtime.requests).toHaveLength(1);
    expect(
      transport.attempts.map((command) =>
        command.type === "reply" ? [command.text, command.final] : [],
      ),
    ).toEqual([
      ["⏳ 已收到，等待 Agent 响应…", false],
      ["你好", true],
      ["你好", true],
    ]);
    expect(transport.commands).toEqual([
      expect.objectContaining({ type: "reply", text: "你好", final: true }),
    ]);
    expect(store.deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveryEvents)).not.toContain("recovering");
    expect(JSON.stringify(deliveryEvents)).not.toContain("chat-a");
  });

  it("dead-letters a delivery after the configured attempt limit", async () => {
    class BrokenTransport extends FakeTransport {
      override async deliver(): Promise<DeliveryReceipt> {
        throw new Error("transport unavailable");
      }
    }
    const transport = new BrokenTransport();
    const runtime = new FakeRuntime();
    const store = new MemoryGatewayStore();
    const phases: string[] = [];
    const gatewayPhases: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      outboxPollIntervalMs: 2,
      outboxRetryBaseMs: 2,
      outboxMaxAttempts: 2,
      onDeliveryLifecycleEvent: (event) => phases.push(event.phase),
      onLifecycleEvent: (event) => gatewayPhases.push(event.phase),
    });
    await gateway.start();
    await transport.receive(message("dead-letter"));
    await waitFor(() => phases.includes("dead-lettered"));
    await gateway.stop();

    expect(runtime.requests).toHaveLength(1);
    expect(phases).toContain("retry-scheduled");
    expect(phases.at(-1)).toBe("dead-lettered");
    expect(store.deliveries.at(-1)?.error).toBe("transport unavailable");
    expect(gatewayPhases).not.toContain("channel-acknowledged");
  });

  it("preserves per-conversation order without globally blocking other conversations", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class PerConversationTransport extends FakeTransport {
      readonly startedConversations: string[] = [];
      private blocked = false;

      override async deliver(
        command: OutboundCommand,
      ): Promise<DeliveryReceipt> {
        this.startedConversations.push(command.conversationId);
        if (command.conversationId === "chat-a" && !this.blocked) {
          this.blocked = true;
          await firstBlocked;
        }
        return super.deliver(command);
      }
    }
    const transport = new PerConversationTransport();
    const runtime = new FakeRuntime();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });
    await gateway.start();

    const first = transport.receive(message("blocked"));
    await waitFor(() => transport.startedConversations.includes("chat-a"));
    const second = transport.receive({
      ...message("independent"),
      conversationId: "chat-b",
    });
    await waitFor(() =>
      transport.commands.some((command) => command.conversationId === "chat-b"),
    );
    releaseFirst();
    await Promise.all([first, second]);
    await gateway.stop();

    expect(transport.startedConversations.slice(0, 2)).toEqual([
      "chat-a",
      "chat-b",
    ]);
  });

  it("rejects excess messages before persistence at the per-conversation limit", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const runtime: AgentRuntimeAdapter = {
      id: "blocked-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {
        started = true;
        await blocked;
        yield { type: "message-completed", text: "done" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const store = new MemoryGatewayStore();
    const events: unknown[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      maxPendingInboundPerConversation: 1,
      onBackpressureEvent: (event) => events.push(event),
    });
    await gateway.start();
    const first = transport.receive(message("first-pending"));
    await waitFor(() => started);
    const rejected = message("rejected-pending");
    await transport.receive(rejected);

    expect(events).toEqual([
      {
        phase: "rejected",
        reason: "conversation-limit",
        conversationType: "direct",
        pendingMessages: 1,
        activeRuns: 1,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("chat-a");
    expect(JSON.stringify(events)).not.toContain("rejected-pending");
    expect(await store.acceptInbound(rejected)).toBe(true);
    release();
    await first;
    await gateway.stop();
  });

  it("enforces the global pending limit across conversations", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const runtime: AgentRuntimeAdapter = {
      id: "globally-blocked-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {
        started = true;
        await blocked;
        yield { type: "message-completed", text: "done" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const events: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      maxPendingInboundMessages: 1,
      onBackpressureEvent: (event) => events.push(event.reason),
    });
    await gateway.start();
    const first = transport.receive(message("global-first"));
    await waitFor(() => started);
    await transport.receive({
      ...message("global-rejected"),
      conversationId: "another-chat",
    });
    expect(events).toEqual(["global-limit"]);
    release();
    await first;
    await gateway.stop();
  });

  it("bounds concurrent Agent runs while retaining accepted work", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "bounded-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run(request) {
        requests.push(request.message.conversationId);
        if (requests.length === 1) await blocked;
        yield { type: "message-completed", text: "done" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      maxConcurrentRuns: 1,
    });
    await gateway.start();
    const first = transport.receive(message("run-one"));
    await waitFor(() => requests.length === 1);
    const second = transport.receive({
      ...message("run-two"),
      conversationId: "chat-b",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toEqual(["chat-a"]);
    release();
    await Promise.all([first, second]);
    await gateway.stop();
    expect(requests).toEqual(["chat-a", "chat-b"]);
  });

  it("drops a duplicate inbound message", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });
    await gateway.start();
    await transport.receive(message("same"));
    await transport.receive(message("same"));
    expect(runtime.requests).toHaveLength(1);
  });

  it("resolves a write approval only from the same conversation and sender", async () => {
    const decisions: string[] = [];
    const lifecycle: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        const decision = await request.requestApproval?.({
          toolName: "test_write",
          effect: "write",
          summary: "执行测试写入",
        });
        decisions.push(decision ?? "missing");
        yield { type: "message-completed", text: `decision:${decision}` };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyUpdateIntervalMs: 1,
      onApprovalLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();

    const original = transport.receive(message("approval-original"));
    await waitFor(() => approvalCode(transport.commands) !== undefined);
    const code = approvalCode(transport.commands)!;
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "proactive",
        text: expect.stringContaining(`/approve ${code}`),
      }),
    );
    expect(
      transport.commands.some(
        (command) =>
          command.type === "reply" && command.text.includes("/approve"),
      ),
    ).toBe(false);
    await transport.receive({
      ...message("approval-wrong-sender"),
      senderId: "user-b",
      parts: [{ type: "text", text: `/approve ${code}` }],
    });
    expect(decisions).toEqual([]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "该审批不存在、已处理、已失效，或不属于当前会话与发送者。",
      final: true,
    });

    await transport.receive({
      ...message("approval-correct"),
      parts: [{ type: "text", text: `/approve ${code}` }],
    });
    await original;
    await gateway.stop();

    expect(decisions).toEqual(["approved"]);
    expect(lifecycle).toEqual(["requested", "approved"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "reply",
        text: "✅ 已批准，继续执行。",
        final: true,
      }),
    );
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "decision:approved",
      final: true,
    });
  });

  it("uses a durable button card for approval and updates it on callback", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const decisions: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "card-approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        decisions.push(
          (await request.requestApproval?.({
            toolName: "test_write",
            effect: "write",
            summary: "写入测试数据",
          })) ?? "missing",
        );
        yield { type: "message-completed", text: "审批后完成" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new InteractiveTransport();
    const store = new MemoryGatewayStore();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      replyUpdateIntervalMs: 1,
    });
    await gateway.start();
    const original = transport.receive(message("card-approval-original"));
    await waitFor(() =>
      transport.commands.some(
        (command) => command.type === "proactive-presentation",
      ),
    );
    const prompt = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    expect(prompt).toMatchObject({
      type: "proactive-presentation",
      presentation: {
        kind: "actions",
        actions: [
          { id: "approve", label: "批准" },
          { id: "deny", label: "拒绝" },
        ],
      },
    });
    if (!prompt || prompt.type !== "proactive-presentation") {
      throw new Error("approval card was not delivered");
    }
    await transport.receive({
      ...message("card-approval-click"),
      parts: [],
      interaction: {
        presentationId: prompt.presentation.id,
        actionId: "approve",
      },
    });
    await original;
    await gateway.stop();

    expect(decisions).toEqual(["approved"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "interaction-update",
        presentation: expect.objectContaining({
          kind: "notice",
          id: prompt.presentation.id,
          body: "✅ 已批准，继续执行。",
        }),
      }),
    );
  });

  it("acknowledges a durable interaction before resuming the same Agent session", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    const resumes: Array<{
      sessionId: string;
      idempotencyKey: string;
      status: "submitted" | "cancelled" | "expired";
      values: Record<string, string[]>;
    }> = [];
    let callbackWasAcknowledged = false;
    const runtime: AgentRuntimeAdapter = {
      id: "interaction-runtime",
      contractVersion: 1,
      capabilities: new Set(["interaction-resume"]),
      async *run() {
        yield { type: "message-completed", text: "unused" };
      },
      async *resumeInteraction(request) {
        callbackWasAcknowledged = transport.commands.some(
          (command) => command.type === "interaction-update",
        );
        resumes.push({
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          status: request.result.status,
          values: request.result.values,
        });
        yield {
          type: "message-completed",
          text: `继续处理：${request.result.values.environment?.[0]}`,
        };
      },
      async health() {
        return { ok: true };
      },
    };
    const lifecycle: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      onInteractionLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();
    const interactionId = await gateway.startRuntimeInteraction({
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      adapterId: runtime.id,
      sessionId: "agent-session-1",
      interaction: {
        kind: "single-select",
        title: "请选择环境",
        fieldId: "environment",
        options: [
          { value: "production-internal", label: "生产环境" },
          { value: "staging-internal", label: "测试环境" },
        ],
      },
    });
    expect(transport.commands.at(-1)).toMatchObject({
      type: "proactive-presentation",
      presentation: {
        kind: "choice",
        id: interactionId,
        questionId: "choice",
        options: [
          { id: "option_0", label: "生产环境" },
          { id: "option_1", label: "测试环境" },
        ],
      },
    });

    await transport.receive({
      ...message("interaction-wrong-sender"),
      senderId: "user-b",
      parts: [],
      interaction: {
        presentationId: interactionId,
        selections: [{ fieldId: "choice", optionIds: ["option_0"] }],
      },
    });
    expect(resumes).toHaveLength(0);

    await transport.receive({
      ...message("interaction-correct"),
      parts: [],
      interaction: {
        presentationId: interactionId,
        selections: [{ fieldId: "choice", optionIds: ["option_0"] }],
      },
    });
    await waitFor(() => resumes.length === 1);
    expect(callbackWasAcknowledged).toBe(true);
    expect(resumes).toEqual([
      {
        sessionId: "agent-session-1",
        idempotencyKey: `interaction-resume:${interactionId}`,
        status: "submitted",
        values: { environment: ["production-internal"] },
      },
    ]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "interaction-update",
        presentation: expect.objectContaining({
          id: interactionId,
          body: "✅ 已提交：生产环境",
        }),
      }),
    );
    await waitFor(() =>
      transport.commands.some(
        (command) =>
          command.type === "proactive" &&
          command.text === "继续处理：production-internal",
      ),
    );

    await transport.receive({
      ...message("interaction-duplicate"),
      parts: [],
      interaction: {
        presentationId: interactionId,
        selections: [{ fieldId: "choice", optionIds: ["option_0"] }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumes).toHaveLength(1);

    const cancelId = await gateway.startRuntimeInteraction({
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      adapterId: runtime.id,
      sessionId: "agent-session-1",
      interaction: { kind: "confirm", title: "是否继续" },
    });
    await transport.receive({
      ...message("interaction-cancel"),
      parts: [],
      interaction: { presentationId: cancelId, actionId: "cancel" },
    });
    await waitFor(() => resumes.length === 2);
    expect(resumes[1]).toMatchObject({ status: "cancelled", values: {} });

    const multiId = await gateway.startRuntimeInteraction({
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      adapterId: runtime.id,
      sessionId: "agent-session-1",
      interaction: {
        kind: "multi-select",
        title: "选择内容",
        fieldId: "content",
        min: 1,
        options: [
          { value: "docs-internal", label: "文档" },
          { value: "todos-internal", label: "待办" },
        ],
      },
    });
    await transport.receive({
      ...message("interaction-multi"),
      parts: [],
      interaction: {
        presentationId: multiId,
        actionId: "submit",
        selections: [
          { fieldId: "choice", optionIds: ["option_0", "option_1"] },
        ],
      },
    });
    await waitFor(() => resumes.length === 3);
    expect(resumes[2]).toMatchObject({
      status: "submitted",
      values: { content: ["docs-internal", "todos-internal"] },
    });

    const expiryId = await gateway.startRuntimeInteraction({
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      adapterId: runtime.id,
      sessionId: "agent-session-1",
      interaction: {
        kind: "confirm",
        title: "即将过期",
        expiresInMs: 5,
      },
    });
    await waitFor(() => resumes.length === 4);
    expect(resumes[3]).toMatchObject({
      idempotencyKey: `interaction-resume:${expiryId}`,
      status: "expired",
      values: {},
    });
    expect(lifecycle).toEqual([
      "requested",
      "submitted",
      "resume-started",
      "resume-delivered",
      "requested",
      "cancelled",
      "resume-started",
      "resume-delivered",
      "requested",
      "submitted",
      "resume-started",
      "resume-delivered",
      "requested",
      "resume-started",
      "resume-delivered",
    ]);
    expect(
      JSON.stringify(
        transport.commands.filter(
          (command) => command.type === "proactive-presentation",
        ),
      ),
    ).not.toContain("production-internal");
    await gateway.stop();
  });

  it("bridges a live Adapter interaction without deadlocking the active conversation", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    let continueRun!: () => void;
    const interactionAnswer = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    const resumed: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "live-interaction-runtime",
      contractVersion: 1,
      capabilities: new Set(["interaction-resume", "interaction-live-resume"]),
      async *run() {
        yield { type: "session-started", sessionId: "live-session" };
        yield {
          type: "interaction-requested",
          request: {
            kind: "single-select",
            title: "选择环境",
            fieldId: "environment",
            options: [
              { value: "prod", label: "生产" },
              { value: "test", label: "测试" },
            ],
          },
        };
        await interactionAnswer;
        yield { type: "text-delta", text: "已切换到测试环境" };
        yield { type: "message-completed", text: "已切换到测试环境" };
      },
      async *resumeInteraction(request) {
        resumed.push(request.result.values.environment?.[0] ?? "missing");
        continueRun();
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      replyUpdateIntervalMs: 1,
      maxConcurrentRuns: 1,
    });
    await gateway.start();
    const original = transport.receive(message("live-interaction-original"));
    await waitFor(() =>
      transport.commands.some(
        (command) => command.type === "proactive-presentation",
      ),
    );
    const prompt = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    if (!prompt || prompt.type !== "proactive-presentation") {
      throw new Error("live interaction card was not delivered");
    }
    await transport.receive({
      ...message("live-interaction-callback"),
      parts: [],
      interaction: {
        presentationId: prompt.presentation.id,
        selections: [{ fieldId: "choice", optionIds: ["option_1"] }],
      },
    });
    await original;
    expect(resumed).toEqual(["test"]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "已切换到测试环境",
      final: true,
    });
    await gateway.stop();
  });

  it("opens a follow-up interaction while the same live Kernel request waits", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    let completeRun!: () => void;
    const answered = new Promise<void>((resolve) => {
      completeRun = resolve;
    });
    const resumes: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "nested-live-interaction-runtime",
      contractVersion: 1,
      capabilities: new Set(["interaction-resume", "interaction-live-resume"]),
      async *run() {
        yield { type: "session-started", sessionId: "nested-live-session" };
        yield {
          type: "interaction-requested",
          request: {
            kind: "single-select",
            title: "选择环境",
            fieldId: "environment",
            options: [
              { value: "prod", label: "生产" },
              { value: "test", label: "测试" },
            ],
          },
        };
        await answered;
        yield { type: "message-completed", text: "两步输入已完成" };
      },
      async *resumeInteraction(request) {
        if (request.interaction.kind === "single-select") {
          resumes.push(request.result.values.environment?.[0] ?? "missing");
          yield {
            type: "interaction-requested",
            request: {
              kind: "confirm",
              title: "确认继续",
            },
          };
          return;
        }
        resumes.push(request.result.status);
        completeRun();
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      replyUpdateIntervalMs: 1,
      maxConcurrentRuns: 1,
    });
    await gateway.start();
    const original = transport.receive(message("nested-live-original"));
    await waitFor(
      () =>
        transport.commands.filter(
          (command) => command.type === "proactive-presentation",
        ).length === 1,
    );
    const first = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    if (!first || first.type !== "proactive-presentation") {
      throw new Error("first live interaction was not delivered");
    }
    await transport.receive({
      ...message("nested-live-first-callback"),
      parts: [],
      interaction: {
        presentationId: first.presentation.id,
        selections: [{ fieldId: "choice", optionIds: ["option_1"] }],
      },
    });
    await waitFor(
      () =>
        transport.commands.filter(
          (command) => command.type === "proactive-presentation",
        ).length === 2,
    );
    const second = transport.commands.filter(
      (command) => command.type === "proactive-presentation",
    )[1];
    if (!second || second.type !== "proactive-presentation") {
      throw new Error("second live interaction was not delivered");
    }
    await transport.receive({
      ...message("nested-live-second-callback"),
      parts: [],
      interaction: {
        presentationId: second.presentation.id,
        actionId: "confirm",
      },
    });
    await original;
    expect(resumes).toEqual(["test", "submitted"]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "两步输入已完成",
      final: true,
    });
    await gateway.stop();
  });

  it("attaches durable final-reply actions and continues the same session once", async () => {
    class ReplyActionTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
        "reply-with-presentation",
      ]);
    }
    const transport = new ReplyActionTransport();
    const resumes: Array<{ sessionId: string; text?: string }> = [];
    const runtime: AgentRuntimeAdapter = {
      id: "reply-action-runtime",
      contractVersion: 1,
      capabilities: new Set([
        "streaming",
        "resume",
        "interaction-resume",
        "interaction-live-resume",
        "reply-actions",
      ]),
      async *run() {
        yield { type: "session-started", sessionId: "reply-action-session" };
        yield { type: "message-completed", text: "第一轮完成" };
      },
      async *resumeInteraction(request) {
        resumes.push({
          sessionId: request.sessionId,
          text:
            request.message?.parts[0]?.type === "text"
              ? request.message.parts[0].text
              : undefined,
        });
        yield { type: "message-completed", text: "已继续展开" };
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyActions: [
        {
          value: "请继续展开上一条回答",
          label: "继续展开",
          style: "primary",
        },
      ],
      outboxPollIntervalMs: 2,
      replyUpdateIntervalMs: 1,
    });
    await gateway.start();
    await transport.receive(message("reply-action-original"));
    const final = transport.commands.find(
      (command) => command.type === "reply" && command.final,
    );
    const card = transport.commands.find(
      (command) => command.type === "proactive-presentation",
    );
    if (
      !final ||
      final.type !== "reply" ||
      !card ||
      card.type !== "proactive-presentation"
    ) {
      throw new Error("final reply and action card were not delivered");
    }
    expect(final).toMatchObject({
      text: "第一轮完成",
      final: true,
    });
    expect(card).toMatchObject({
      type: "proactive-presentation",
      presentation: {
        kind: "actions",
        title: "接下来",
        actions: [{ id: "action_0", label: "继续展开", style: "primary" }],
      },
    });
    const callback = {
      ...message("reply-action-callback"),
      parts: [],
      interaction: {
        presentationId: card.presentation.id,
        actionId: "action_0",
      },
      replyReference: { requestId: "reply-action-callback-request" },
    };
    await transport.receive(callback);
    await waitFor(() => resumes.length === 1);
    await waitFor(() =>
      transport.commands.some(
        (command) =>
          command.type === "proactive" && command.text === "已继续展开",
      ),
    );
    expect(resumes).toEqual([
      {
        sessionId: "reply-action-session",
        text: "请继续展开上一条回答",
      },
    ]);
    expect(
      transport.commands.filter(
        (command) => command.type === "interaction-update",
      ),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      transport.commands.filter(
        (command) => command.type === "proactive-presentation",
      ),
    ).toHaveLength(1);
    await transport.receive({ ...callback, id: "reply-action-duplicate" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumes).toHaveLength(1);
    expect(
      transport.commands.filter(
        (command) => command.type === "interaction-update",
      ),
    ).toHaveLength(1);
    await gateway.stop();
  });

  it("keeps peer actions neutral unless the Adapter declares visual intent", async () => {
    class InteractiveTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "proactive-message",
        "structured-presentation",
        "interactive-presentation",
      ]);
    }
    const transport = new InteractiveTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "styled-interaction-runtime",
      contractVersion: 1,
      capabilities: new Set(["interaction-resume"]),
      async *run() {
        yield { type: "message-completed", text: "unused" };
      },
      async *resumeInteraction() {},
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });
    await gateway.start();
    await gateway.startRuntimeInteraction({
      accountId: "bot-a",
      conversationId: "chat-a",
      conversationType: "direct",
      senderId: "user-a",
      adapterId: runtime.id,
      sessionId: "styled-session",
      interaction: {
        kind: "actions",
        title: "选择操作",
        actions: [
          { value: "inspect", label: "查看" },
          { value: "delete", label: "删除", style: "danger" },
        ],
      },
    });
    expect(transport.commands.at(-1)).toMatchObject({
      type: "proactive-presentation",
      presentation: {
        kind: "actions",
        actions: [
          { id: "action_0", label: "查看", style: "default" },
          { id: "action_1", label: "删除", style: "danger" },
        ],
      },
    });
    await gateway.stop();
  });

  it("uses the next scoped plain-text message for a live text interaction", async () => {
    const transport = new FakeTransport();
    let continueRun!: () => void;
    const interactionAnswer = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    const resumed: string[] = [];
    let runs = 0;
    const runtime: AgentRuntimeAdapter = {
      id: "live-text-runtime",
      contractVersion: 1,
      capabilities: new Set(["interaction-resume", "interaction-live-resume"]),
      async *run() {
        runs += 1;
        yield { type: "session-started", sessionId: "live-text-session" };
        yield {
          type: "interaction-requested",
          request: {
            kind: "text-input",
            title: "请输入项目名称",
            fieldId: "name",
            placeholder: "例如 Gateway",
          },
        };
        await interactionAnswer;
        yield { type: "message-completed", text: "名称已记录" };
      },
      async *resumeInteraction(request) {
        resumed.push(request.result.values.name?.[0] ?? "missing");
        continueRun();
      },
      async health() {
        return { ok: true };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      outboxPollIntervalMs: 2,
      replyUpdateIntervalMs: 1,
      maxConcurrentRuns: 1,
    });
    await gateway.start();
    const original = transport.receive(message("live-text-original"));
    await waitFor(() =>
      transport.commands.some(
        (command) =>
          command.type === "proactive" &&
          command.text.includes("请输入项目名称"),
      ),
    );
    await transport.receive({
      ...message("live-text-answer"),
      parts: [{ type: "text", text: "Agent Gateway" }],
    });
    await original;
    expect(runs).toBe(1);
    expect(resumed).toEqual(["Agent Gateway"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "reply",
        text: "✅ 已提交，正在继续。",
        final: true,
      }),
    );
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "名称已记录",
      final: true,
    });
    await gateway.stop();
  });

  it("expires an unanswered approval without hanging the Agent run", async () => {
    const lifecycle: string[] = [];
    let decision = "";
    const runtime: AgentRuntimeAdapter = {
      id: "expiring-approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        decision =
          (await request.requestApproval?.({
            toolName: "test_delete",
            effect: "destructive",
            summary: "执行测试删除",
            maxWaitMs: 10,
          })) ?? "missing";
        yield { type: "message-completed", text: `decision:${decision}` };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      approvalTimeoutMs: 1_000,
      replyUpdateIntervalMs: 1,
      onApprovalLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();
    await transport.receive(message("approval-timeout"));
    await gateway.stop();

    expect(decision).toBe("expired");
    expect(lifecycle).toEqual(["requested", "expired"]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "decision:expired",
      final: true,
    });
  });

  it("fails closed when the transport cannot keep an approval prompt independent", async () => {
    class ReplyOnlyTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
      ]);
    }
    const runtime: AgentRuntimeAdapter = {
      id: "unsupported-approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        await request.requestApproval!({
          toolName: "test_write",
          effect: "write",
          summary: "执行测试写入",
        });
        yield { type: "message-completed", text: "must not complete" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new ReplyOnlyTransport();
    const lifecycle: string[] = [];
    const errors: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onApprovalLifecycleEvent: (event) => lifecycle.push(event.phase),
      onRuntimeError: (error) => errors.push(error.message),
    });
    await gateway.start();
    await transport.receive(message("approval-unsupported-transport"));
    await gateway.stop();

    expect(lifecycle).toEqual(["requested", "interrupted"]);
    expect(errors).toEqual([
      "Transport fake-wecom cannot deliver a durable approval prompt",
    ]);
    expect(approvalCodes(transport.commands)).toEqual([]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "Agent 处理失败，请稍后重试。",
      final: true,
    });
  });

  it("serializes concurrent approval requests so mutable prompts are not overwritten", async () => {
    let decisions: string[] = [];
    const runtime: AgentRuntimeAdapter = {
      id: "parallel-approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        decisions = await Promise.all([
          request.requestApproval!({
            toolName: "test_write_one",
            effect: "write",
            summary: "执行第一项测试写入",
          }),
          request.requestApproval!({
            toolName: "test_write_two",
            effect: "write",
            summary: "执行第二项测试写入",
          }),
        ]);
        yield { type: "message-completed", text: decisions.join(",") };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyUpdateIntervalMs: 1,
    });
    await gateway.start();
    const original = transport.receive(message("approval-parallel"));

    await waitFor(() => approvalCodes(transport.commands).length === 1);
    const firstCode = approvalCodes(transport.commands)[0]!;
    await transport.receive({
      ...message("approval-parallel-first"),
      parts: [{ type: "text", text: `/approve ${firstCode}` }],
    });
    await waitFor(() => approvalCodes(transport.commands).length === 2);
    const secondCode = approvalCodes(transport.commands)[1]!;
    expect(secondCode).not.toBe(firstCode);
    await transport.receive({
      ...message("approval-parallel-second"),
      parts: [{ type: "text", text: `/deny ${secondCode}` }],
    });
    await original;
    await gateway.stop();

    expect(decisions).toEqual(["approved", "denied"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "reply",
        text: "approved,denied",
        final: true,
      }),
    );
  });

  it("interrupts a pending approval during graceful shutdown", async () => {
    let decision = "";
    const runtime: AgentRuntimeAdapter = {
      id: "interrupted-approval-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        decision =
          (await request.requestApproval?.({
            toolName: "test_write",
            effect: "write",
            summary: "执行测试写入",
          })) ?? "missing";
        yield { type: "message-completed", text: `decision:${decision}` };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyUpdateIntervalMs: 1,
    });
    await gateway.start();
    const original = transport.receive(message("approval-interrupted"));
    await waitFor(() => approvalCode(transport.commands) !== undefined);
    await gateway.stop();
    await original;

    expect(decision).toBe("interrupted");
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "decision:interrupted",
      final: true,
    });
  });

  it("interrupts an orphaned approval when the Kernel turn ends first", async () => {
    let releaseRun!: () => void;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let decision = "";
    const runtime: AgentRuntimeAdapter = {
      id: "early-ending-runtime",
      contractVersion: 1,
      capabilities: new Set(["approval"]),
      async *run(request) {
        void request.requestApproval!({
          toolName: "test_write",
          effect: "write",
          summary: "执行测试写入",
          maxWaitMs: 60_000,
        }).then((value) => {
          decision = value;
        });
        await runReleased;
        yield { type: "message-completed", text: "Kernel ended" };
      },
      async health() {
        return { ok: true };
      },
    };
    const transport = new FakeTransport();
    const lifecycle: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      replyUpdateIntervalMs: 1,
      onApprovalLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();
    const original = transport.receive(message("approval-orphan"));
    await waitFor(() => approvalCode(transport.commands) !== undefined);
    releaseRun();
    await original;
    await waitFor(() => decision === "interrupted");
    await gateway.stop();

    expect(lifecycle).toEqual(["requested", "interrupted"]);
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "reply",
        text: "Kernel ended",
        final: true,
      }),
    );
  });

  it("passes materialized media to the adapter and releases it after the run", async () => {
    class MediaTransport extends FakeTransport {
      released = false;
      async materializeInbound(
        inbound: InboundMessage,
      ): Promise<MaterializedInboundMessage> {
        return {
          message: {
            ...inbound,
            parts: [
              { type: "text", text: "看图" },
              {
                type: "image",
                path: "/protected/run/image.png",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 8,
              },
            ],
          },
          release: async () => {
            this.released = true;
          },
        };
      }
    }
    class MediaRuntime extends FakeRuntime {
      override readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
        "streaming",
        "resume",
        "multimodal-input",
      ]);
      readonly inputModalities: ReadonlySet<MediaType> = new Set(["image"]);
    }
    const transport = new MediaTransport();
    const runtime = new MediaRuntime();
    const lifecycle: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onLifecycleEvent: (event) => lifecycle.push(event.phase),
    });
    await gateway.start();
    await transport.receive({
      ...message("media"),
      parts: [
        {
          type: "image",
          url: "https://example.invalid/encrypted",
          aesKey: "one-time-key",
        },
      ],
    });

    expect(runtime.requests[0]?.message.parts).toEqual([
      { type: "text", text: "看图" },
      {
        type: "image",
        path: "/protected/run/image.png",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 8,
      },
    ]);
    expect(transport.released).toBe(true);
    expect(lifecycle).toContain("media-materialized");
  });

  it("releases materialized media when the adapter fails", async () => {
    let released = false;
    class MediaTransport extends FakeTransport {
      async materializeInbound(
        inbound: InboundMessage,
      ): Promise<MaterializedInboundMessage> {
        return {
          message: {
            ...inbound,
            parts: [{ type: "image", path: "/protected/image.png" }],
          },
          release: async () => {
            released = true;
          },
        };
      }
    }
    const transport = new MediaTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "failing-media-runtime",
      contractVersion: 1,
      capabilities: new Set(["multimodal-input"]),
      async *run() {
        throw new Error("vision failed");
      },
      async health() {
        return { ok: false };
      },
    };
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
    });
    await gateway.start();
    await transport.receive({
      ...message("failed-media"),
      parts: [
        {
          type: "image",
          url: "https://example.invalid/encrypted",
          aesKey: "key",
        },
      ],
    });

    expect(released).toBe(true);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "Agent 处理失败，请稍后重试。",
      final: true,
    });
  });

  it("rejects undeclared input modalities before entering the Kernel", async () => {
    let released = false;
    let runs = 0;
    class MediaTransport extends FakeTransport {
      readonly inputModalities: ReadonlySet<MediaType> = new Set([
        "image",
        "file",
      ]);
      async materializeInbound(
        inbound: InboundMessage,
      ): Promise<MaterializedInboundMessage> {
        return {
          message: {
            ...inbound,
            parts: [
              {
                type: "file",
                path: "/protected/report.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
          release: async () => {
            released = true;
          },
        };
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "image-only-runtime",
      contractVersion: 1,
      capabilities: new Set(["multimodal-input"]),
      inputModalities: new Set(["image"]),
      async *run() {
        runs += 1;
        yield { type: "message-completed", text: "unexpected" };
      },
      async health() {
        return { ok: true };
      },
    };
    const errors: string[] = [];
    const transport = new MediaTransport();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onRuntimeError: (error) => errors.push(error.message),
    });
    await gateway.start();
    await transport.receive({
      ...message("unsupported-file"),
      parts: [
        {
          type: "file",
          url: "https://example.invalid/encrypted",
          aesKey: "key",
        },
      ],
    });

    expect(runs).toBe(0);
    expect(released).toBe(true);
    expect(errors).toEqual([
      "Adapter image-only-runtime cannot accept file input",
    ]);
  });

  it("fails closed before the Kernel when quoted context is undeclared", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const errors: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onRuntimeError: (error) => errors.push(error.message),
    });
    await gateway.start();
    await transport.receive({
      ...message("quoted-unsupported"),
      quote: { parts: [{ type: "text", text: "earlier" }] },
      parts: [{ type: "text", text: "current" }],
    });

    expect(runtime.requests).toHaveLength(0);
    expect(errors).toEqual([
      "Adapter fake-runtime cannot preserve quoted message context",
    ]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "Agent 处理失败，请稍后重试。",
      final: true,
    });
  });

  it("delivers declared Agent media output after finalizing the text reply", async () => {
    class MediaOutputTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "media-upload",
        "multimodal-output",
      ]);
    }
    const transport = new MediaOutputTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "media-output-runtime",
      contractVersion: 1,
      capabilities: new Set(["streaming", "multimodal-output"]),
      async *run() {
        yield { type: "text-delta", text: "文件已生成" };
        yield {
          type: "media-output",
          media: {
            type: "file",
            path: "/allowed/report.pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
          },
        };
        yield { type: "message-completed" };
      },
      async health() {
        return { ok: true };
      },
    };
    const store = new MemoryGatewayStore();
    const mediaSpool = new FakeMediaSpool();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      mediaSpool,
    });
    await gateway.start();
    await transport.receive(message("media-output"));

    expect(transport.commands).toEqual([
      expect.objectContaining({ type: "reply", final: false }),
      expect.objectContaining({
        type: "reply",
        text: "文件已生成",
        final: true,
      }),
      {
        type: "proactive-media",
        accountId: "bot-a",
        conversationId: "chat-a",
        media: {
          type: "file",
          path: "/spool/artifact-1/data",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          sha256: "fake-sha256",
        },
      },
    ]);
    expect(store.deliveries).toHaveLength(3);
    expect(mediaSpool.released).toEqual(["artifact-1"]);
  });

  it("retries media from the spool and releases it only after delivery", async () => {
    class RecoveringMediaTransport extends FakeTransport {
      override readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "stream-reply-update",
        "media-upload",
        "multimodal-output",
      ]);
      mediaAttempts = 0;

      override async deliver(
        command: OutboundCommand,
      ): Promise<DeliveryReceipt> {
        if (command.type === "proactive-media" && ++this.mediaAttempts === 1) {
          throw new Error("temporary upload failure");
        }
        return super.deliver(command);
      }
    }
    const transport = new RecoveringMediaTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "recovering-media-runtime",
      contractVersion: 1,
      capabilities: new Set(["multimodal-output"]),
      async *run() {
        yield {
          type: "media-output",
          media: { type: "image", path: "/allowed/generated.png" },
        };
        yield { type: "message-completed", text: "done" };
      },
      async health() {
        return { ok: true };
      },
    };
    const mediaSpool = new FakeMediaSpool();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      mediaSpool,
      outboxPollIntervalMs: 2,
      outboxRetryBaseMs: 50,
    });
    await gateway.start();
    await transport.receive(message("retry-media"));
    expect(mediaSpool.released).toEqual([]);
    await waitFor(() => mediaSpool.released.length === 1);
    await gateway.stop();

    expect(transport.mediaAttempts).toBe(2);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "proactive-media",
      media: { path: "/spool/artifact-1/data" },
    });
    expect(mediaSpool.released).toEqual(["artifact-1"]);
  });

  it("fails closed when an allowlist does not authorize the sender", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const store = new MemoryGatewayStore();
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store,
      policy: new AllowlistPolicy({ allowedSenders: ["another-user"] }),
    });
    await gateway.start();
    await transport.receive(message("denied"));
    expect(runtime.requests).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
    expect(await store.acceptInbound(message("denied"))).toBe(true);
  });

  it("reports access decisions without conversation identifiers", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const decisions: unknown[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      policy: new AllowlistPolicy({ allowedConversations: ["chat-a"] }),
      onAccessDecision: (event) => decisions.push(event),
    });
    await gateway.start();
    await transport.receive(message("allowed"));
    expect(decisions).toEqual([{ conversationType: "direct", allowed: true }]);
    expect(JSON.stringify(decisions)).not.toContain("chat-a");
  });

  it("reports channel and kernel latency phases without identifiers", async () => {
    const transport = new FakeTransport();
    const runtime = new FakeRuntime();
    const events: unknown[] = [];
    let clock = 0;
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      now: () => clock++,
      onLifecycleEvent: (event) => events.push(event),
    });
    await gateway.start();
    await transport.receive(message("secret-message-id"));

    expect(events.map((event) => (event as { phase: string }).phase)).toEqual([
      "queue-left",
      "channel-acknowledged",
      "kernel-first-event",
      "kernel-first-text",
      "completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-message-id");
    expect(JSON.stringify(events)).not.toContain("chat-a");
  });

  it("scopes direct senders so they cannot authorize another group", async () => {
    const policy = new AllowlistPolicy({
      allowedDirectSenders: ["user-a"],
      allowedGroupConversations: ["approved-group"],
    });
    expect(await policy.authorize(message("direct"))).toEqual({
      allowed: true,
    });
    expect(
      await policy.authorize({
        ...message("other-group"),
        conversationId: "unapproved-group",
        conversationType: "group",
      }),
    ).toEqual({
      allowed: false,
      reason: "sender and conversation are not allowlisted",
    });
  });

  it("does not expose runtime error details to the conversation", async () => {
    const transport = new FakeTransport();
    const runtime: AgentRuntimeAdapter = {
      id: "failing-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {
        throw new Error("sensitive internal detail");
      },
      async health() {
        return { ok: false };
      },
    };
    const errors: string[] = [];
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: new MemoryGatewayStore(),
      onRuntimeError: (error) => errors.push(error.message),
    });
    await gateway.start();
    await transport.receive(message("failure"));
    expect(errors).toEqual(["sensitive internal detail"]);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "reply",
      text: "Agent 处理失败，请稍后重试。",
      final: true,
    });
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function approvalCode(commands: OutboundCommand[]): string | undefined {
  return approvalCodes(commands)[0];
}

function approvalCodes(commands: OutboundCommand[]): string[] {
  const codes: string[] = [];
  for (const command of commands) {
    if (!("text" in command)) continue;
    const match = command.text.match(/\/approve ([A-F0-9]{8})/);
    if (match?.[1] && !codes.includes(match[1])) codes.push(match[1]);
  }
  return codes;
}
