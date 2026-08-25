import { randomUUID } from "node:crypto";
import {
  assertRuntimeAdapterCompatible,
  type AgentMediaOutput,
  type AgentRuntimeAdapter,
  type ChannelTransport,
  type DeliveryOutboxEntry,
  type DurableMediaArtifact,
  type DurableOutboundCommand,
  type GatewayStore,
  type InboundMessage,
  type InboundPolicy,
  type MediaSpool,
  type MediaType,
  type OutboundCommand,
  type RuntimeApprovalDecision,
  type RuntimeApprovalRequest,
  type RuntimeRouter,
} from "@fyaic/wecom-runtime-contract";
import { AgentReplyProjection, MutableReply } from "./mutable-reply.js";

export interface GatewayOptions {
  transport: ChannelTransport;
  adapters: Iterable<AgentRuntimeAdapter>;
  router: RuntimeRouter;
  store: GatewayStore;
  mediaSpool?: MediaSpool;
  policy?: InboundPolicy;
  onAccessDecision?: (event: {
    conversationType: InboundMessage["conversationType"];
    allowed: boolean;
    reason?: string;
  }) => void;
  onRuntimeError?: (error: Error) => void;
  onInfrastructureError?: (event: InfrastructureErrorEvent) => void;
  onDeliveryLifecycleEvent?: (event: DeliveryLifecycleEvent) => void;
  onBackpressureEvent?: (event: BackpressureEvent) => void;
  onLifecycleEvent?: (event: GatewayLifecycleEvent) => void;
  onAdapterLifecycleEvent?: (event: AdapterLifecycleEvent) => void;
  onApprovalLifecycleEvent?: (event: ApprovalLifecycleEvent) => void;
  replyUpdateIntervalMs?: number;
  maxOutboundMediaPerRun?: number;
  outboxPollIntervalMs?: number;
  outboxLeaseMs?: number;
  outboxMaxAttempts?: number;
  outboxRetryBaseMs?: number;
  outboxRetryMaxMs?: number;
  outboxBatchSize?: number;
  maxPendingInboundMessages?: number;
  maxPendingInboundPerConversation?: number;
  maxConcurrentRuns?: number;
  approvalTimeoutMs?: number;
  maxProactiveTextBytes?: number;
  now?: () => number;
  wallClock?: () => number;
}

export type ProactiveDeliveryState = "delivered" | "queued";

export interface ProactiveTextRequest {
  accountId: string;
  conversationId: string;
  text: string;
}

export interface ProactiveMediaRequest {
  accountId: string;
  conversationId: string;
  media: AgentMediaOutput;
}

export type GatewayOperationalState =
  "stopped" | "starting" | "running" | "stopping";

/** Aggregate operational state. It intentionally contains no identifiers or content. */
export interface GatewayOperationalSnapshot {
  state: GatewayOperationalState;
  ready: boolean;
  transportHealthy: boolean;
  adapters: { total: number; healthy: number };
  storeHealthy: boolean;
  work: {
    pendingInboundMessages: number;
    activeRuns: number;
    pendingApprovals: number;
  };
  outbox: {
    pending: number;
    leased: number;
    delivered: number;
    dead: number;
    superseded: number;
  };
}

export interface GatewayLifecycleEvent {
  phase:
    | "queue-left"
    | "channel-acknowledged"
    | "media-materialized"
    | "kernel-first-event"
    | "kernel-first-text"
    | "completed"
    | "failed";
  conversationType: InboundMessage["conversationType"];
  adapterId?: string;
  elapsedMs: number;
  measuredFrom: "enqueued" | "media-start" | "adapter-run";
}

export interface AdapterLifecycleEvent {
  adapterId: string;
  phase: "starting" | "ready" | "stopped" | "failed";
  elapsedMs: number;
}

export interface InfrastructureErrorEvent {
  component: "transport" | "adapter" | "store" | "media-spool";
  componentId: string;
  operation:
    | "start"
    | "stop"
    | "release-media"
    | "deliver"
    | "enqueue-delivery"
    | "claim-delivery"
    | "complete-delivery"
    | "retry-delivery"
    | "dead-letter-delivery"
    | "create-approval"
    | "resolve-approval"
    | "interrupt-approval"
    | "reconcile"
    | "stage"
    | "materialize"
    | "release";
  error: Error;
}

export interface DeliveryLifecycleEvent {
  phase: "enqueued" | "delivered" | "retry-scheduled" | "dead-lettered";
  commandType: DurableOutboundCommand["type"];
  attempts: number;
}

export interface BackpressureEvent {
  phase: "rejected";
  reason: "global-limit" | "conversation-limit";
  conversationType: InboundMessage["conversationType"];
  pendingMessages: number;
  activeRuns: number;
}

export interface ApprovalLifecycleEvent {
  phase: "requested" | "approved" | "denied" | "expired" | "interrupted";
  conversationType: InboundMessage["conversationType"];
  toolName: string;
  effect: "write" | "destructive";
  elapsedMs: number;
}

interface PendingApprovalResolver {
  resolve: (decision: RuntimeApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  requestedAt: number;
  conversationType: InboundMessage["conversationType"];
  toolName: string;
  effect: "write" | "destructive";
  runId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
}

export class WeComAgentGateway {
  private readonly adapters: Map<string, AgentRuntimeAdapter>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly deliveryOwner = randomUUID();
  private outboxTimer: ReturnType<typeof setTimeout> | undefined;
  private activeOutboxFlush: Promise<void> | undefined;
  private readonly pendingByConversation = new Map<string, number>();
  private readonly runWaiters: Array<() => void> = [];
  private readonly approvalResolvers = new Map<
    string,
    PendingApprovalResolver
  >();
  private pendingInboundMessages = 0;
  private activeRuns = 0;
  private starting = false;
  private started = false;
  private stopping = false;

  constructor(private readonly options: GatewayOptions) {
    const adapters = Array.from(options.adapters);
    for (const adapter of adapters) assertRuntimeAdapterCompatible(adapter);
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    if (this.adapters.size !== adapters.length) {
      throw new Error("Adapter ids must be unique within one Gateway process");
    }
  }

  async sendProactiveText(
    request: ProactiveTextRequest,
  ): Promise<ProactiveDeliveryState> {
    this.assertProactiveReady();
    assertOpaqueTarget(request.accountId, "accountId");
    assertOpaqueTarget(request.conversationId, "conversationId");
    if (!request.text.trim()) {
      throw new Error("Proactive text must not be empty");
    }
    if (
      Buffer.byteLength(request.text, "utf8") >
      (this.options.maxProactiveTextBytes ?? 20_000)
    ) {
      throw new Error("Proactive text exceeds the configured byte limit");
    }
    const delivered = await this.enqueueDurableDelivery(randomUUID(), {
      type: "proactive",
      accountId: request.accountId,
      conversationId: request.conversationId,
      text: request.text,
    });
    return delivered ? "delivered" : "queued";
  }

  async sendProactiveMedia(
    request: ProactiveMediaRequest,
  ): Promise<ProactiveDeliveryState> {
    this.assertProactiveReady();
    assertOpaqueTarget(request.accountId, "accountId");
    assertOpaqueTarget(request.conversationId, "conversationId");
    if (
      !this.options.transport.capabilities.has("media-upload") ||
      !this.options.transport.capabilities.has("multimodal-output")
    ) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver proactive media`,
      );
    }
    if (
      this.options.transport.outputModalities &&
      !this.options.transport.outputModalities.has(request.media.type)
    ) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver ${request.media.type} output`,
      );
    }
    const delivered = await this.enqueueProactiveMedia(
      randomUUID(),
      request.accountId,
      request.conversationId,
      request.media,
    );
    return delivered ? "delivered" : "queued";
  }

  async operationalSnapshot(): Promise<GatewayOperationalSnapshot> {
    const state: GatewayOperationalState = this.stopping
      ? "stopping"
      : this.starting
        ? "starting"
        : this.started
          ? "running"
          : "stopped";
    const componentHealth = state === "running";
    const [transport, adapterResults, outbox] = await Promise.all([
      componentHealth
        ? this.options.transport.health().then(
            (result) => result.ok,
            () => false,
          )
        : false,
      componentHealth
        ? Promise.all(
            [...this.adapters.values()].map((adapter) =>
              adapter.health().then(
                (result) => result.ok,
                () => false,
              ),
            ),
          )
        : [...this.adapters.values()].map(() => false),
      this.options.store.getDeliveryOutboxStats().then(
        (result) => ({ ok: true as const, result }),
        () => ({ ok: false as const, result: emptyOutboxStats() }),
      ),
    ]);
    const healthyAdapters = adapterResults.filter(Boolean).length;
    const ready =
      state === "running" &&
      transport &&
      adapterResults.length > 0 &&
      healthyAdapters === adapterResults.length &&
      outbox.ok;
    return {
      state,
      ready,
      transportHealthy: transport,
      adapters: { total: adapterResults.length, healthy: healthyAdapters },
      storeHealthy: outbox.ok,
      work: {
        pendingInboundMessages: this.pendingInboundMessages,
        activeRuns: this.activeRuns,
        pendingApprovals: this.approvalResolvers.size,
      },
      outbox: outbox.result,
    };
  }

  async start(): Promise<void> {
    this.starting = true;
    try {
      await this.startComponents();
    } finally {
      this.starting = false;
    }
  }

  private async startComponents(): Promise<void> {
    try {
      await this.options.store.interruptPendingApprovals(this.wallClockIso());
    } catch (error) {
      this.notifyApprovalStoreError("interrupt-approval", error);
      throw error;
    }
    if (this.options.mediaSpool) {
      try {
        await this.options.mediaSpool.start?.();
        const referenced =
          await this.options.store.listReferencedMediaArtifactIds();
        await this.options.mediaSpool.reconcile(new Set(referenced));
      } catch (error) {
        this.notifyInfrastructureError({
          component: "media-spool",
          componentId: this.options.mediaSpool.id,
          operation: "reconcile",
          error: asError(error),
        });
        throw error;
      }
    }
    const adapters = [...this.adapters.values()];
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const startedAt = this.now();
        this.notifyAdapterLifecycle(adapter.id, "starting", 0);
        try {
          await adapter.start?.();
          this.notifyAdapterLifecycle(
            adapter.id,
            "ready",
            this.now() - startedAt,
          );
        } catch (error) {
          this.notifyAdapterLifecycle(
            adapter.id,
            "failed",
            this.now() - startedAt,
          );
          this.notifyInfrastructureError({
            component: "adapter",
            componentId: adapter.id,
            operation: "start",
            error: asError(error),
          });
          throw error;
        }
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      await Promise.allSettled(adapters.map((adapter) => adapter.stop?.()));
      throw failure.reason;
    }
    try {
      await this.options.transport.start(async (message) =>
        this.enqueue(message),
      );
      this.started = true;
      this.stopping = false;
      this.scheduleOutbox(0);
    } catch (error) {
      await Promise.allSettled(adapters.map((adapter) => adapter.stop?.()));
      this.notifyInfrastructureError({
        component: "transport",
        componentId: this.options.transport.id,
        operation: "start",
        error: asError(error),
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Stop ingress first, then drain accepted work, then release adapters.
    this.stopping = true;
    await this.interruptApprovals();
    this.clearOutboxTimer();
    const transportStop = await Promise.allSettled([
      this.options.transport.stop(),
    ]);
    await Promise.allSettled(this.queues.values());
    if (this.activeOutboxFlush) await this.activeOutboxFlush;
    await Promise.allSettled(this.deliveryQueues.values());
    await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        const startedAt = this.now();
        try {
          await adapter.stop?.();
          this.notifyAdapterLifecycle(
            adapter.id,
            "stopped",
            this.now() - startedAt,
          );
        } catch (error) {
          this.notifyAdapterLifecycle(
            adapter.id,
            "failed",
            this.now() - startedAt,
          );
          this.notifyInfrastructureError({
            component: "adapter",
            componentId: adapter.id,
            operation: "stop",
            error: asError(error),
          });
        }
      }),
    );
    const transportFailure = transportStop[0];
    if (transportFailure?.status === "rejected") {
      this.notifyInfrastructureError({
        component: "transport",
        componentId: this.options.transport.id,
        operation: "stop",
        error: asError(transportFailure.reason),
      });
    }
    this.started = false;
    this.stopping = false;
  }

  private async enqueue(message: InboundMessage): Promise<void> {
    const enqueuedAt = this.now();
    if (this.options.policy) {
      const decision = await this.options.policy.authorize(message);
      this.notifyAccessDecision({
        conversationType: message.conversationType,
        ...decision,
      });
      if (!decision.allowed) return;
    }
    const approvalControl = parseApprovalControl(message);
    if (approvalControl) {
      if (!(await this.options.store.acceptInbound(message))) return;
      await this.handleApprovalControl(message, approvalControl);
      return;
    }
    const key = `${message.accountId}:${message.conversationId}`;
    const rejection = this.reserveInbound(key);
    if (rejection) {
      this.notifyBackpressure({
        phase: "rejected",
        reason: rejection,
        conversationType: message.conversationType,
        pendingMessages: this.pendingInboundMessages,
        activeRuns: this.activeRuns,
      });
      return;
    }
    try {
      if (!(await this.options.store.acceptInbound(message))) return;
      const previous = this.queues.get(key) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () =>
          this.withRunSlot(async () => this.handle(message, enqueuedAt)),
        );
      this.queues.set(key, current);
      try {
        await current;
      } finally {
        if (this.queues.get(key) === current) this.queues.delete(key);
      }
    } finally {
      this.releaseInbound(key);
    }
  }

  private async handle(
    message: InboundMessage,
    enqueuedAt: number,
  ): Promise<void> {
    this.notifyLifecycle(
      message,
      "queue-left",
      this.now() - enqueuedAt,
      "enqueued",
    );
    const route = await this.options.router.resolve(message);
    const adapter = this.adapters.get(route.adapterId);
    if (!adapter)
      throw new Error(`Runtime adapter not found: ${route.adapterId}`);

    const scope = {
      accountId: message.accountId,
      conversationId: message.conversationId,
      adapterId: adapter.sessionCompatibilityId ?? adapter.id,
    };
    const sessionId = await this.options.store.getSession(scope);
    const streamId = `run-${message.id}`;
    const projection = new AgentReplyProjection();
    let channelAcknowledged = false;
    const reply = new MutableReply(
      async (update) => {
        const delivered = await this.reply(
          message,
          streamId,
          update.text,
          update.final,
        );
        if (delivered && !channelAcknowledged) {
          channelAcknowledged = true;
          this.notifyLifecycle(
            message,
            "channel-acknowledged",
            this.now() - enqueuedAt,
            "enqueued",
            adapter.id,
          );
        }
      },
      { updateIntervalMs: this.options.replyUpdateIntervalMs },
    );
    let closed = false;
    const mediaOutputs: AgentMediaOutput[] = [];
    let releaseMedia: () => Promise<void> = async () => undefined;

    try {
      // Establish the mutable Bot message before waiting for the Agent. This is
      // a neutral transport acknowledgement, not a claim about Agent state.
      await reply.open();
      const mediaStartedAt = this.now();
      const materialized = this.options.transport.materializeInbound
        ? await this.options.transport.materializeInbound(message)
        : { message, release: async () => undefined };
      releaseMedia = materialized.release;
      if (message.parts.some((part) => part.type !== "text")) {
        this.notifyLifecycle(
          message,
          "media-materialized",
          this.now() - mediaStartedAt,
          "media-start",
          adapter.id,
        );
      }
      assertInboundModalities(
        this.options.transport,
        adapter,
        materialized.message,
      );
      const kernelStartedAt = this.now();
      let sawKernelEvent = false;
      let sawKernelText = false;
      let approvalQueue = Promise.resolve();
      for await (const event of adapter.run({
        message: materialized.message,
        sessionId,
        requestApproval: (request) => {
          const decision = approvalQueue.then(() =>
            this.requestApproval(streamId, message, adapter, reply, request),
          );
          approvalQueue = decision.then(
            () => undefined,
            () => undefined,
          );
          return decision;
        },
      })) {
        if (!sawKernelEvent) {
          sawKernelEvent = true;
          this.notifyLifecycle(
            message,
            "kernel-first-event",
            this.now() - kernelStartedAt,
            "adapter-run",
            adapter.id,
          );
        }
        if (event.type === "text-delta" && !sawKernelText) {
          sawKernelText = true;
          this.notifyLifecycle(
            message,
            "kernel-first-text",
            this.now() - kernelStartedAt,
            "adapter-run",
            adapter.id,
          );
        }
        if (event.type === "session-started") {
          await this.options.store.setSession({
            ...scope,
            sessionId: event.sessionId,
          });
        } else if (event.type === "status" || event.type === "text-delta") {
          const text = projection.apply(event);
          if (text !== undefined) reply.update(text);
        } else if (event.type === "message-completed") {
          await reply.close(projection.completed(event.text));
          closed = true;
        } else if (event.type === "media-output") {
          if (!adapter.capabilities.has("multimodal-output")) {
            throw new Error(
              `Adapter ${adapter.id} emitted media without declaring multimodal-output`,
            );
          }
          if (
            !this.options.transport.capabilities.has("media-upload") ||
            !this.options.transport.capabilities.has("multimodal-output")
          ) {
            throw new Error(
              `Transport ${this.options.transport.id} cannot deliver media output`,
            );
          }
          if (
            adapter.outputModalities &&
            !adapter.outputModalities.has(event.media.type)
          ) {
            throw new Error(
              `Adapter ${adapter.id} emitted undeclared ${event.media.type} output`,
            );
          }
          if (
            this.options.transport.outputModalities &&
            !this.options.transport.outputModalities.has(event.media.type)
          ) {
            throw new Error(
              `Transport ${this.options.transport.id} cannot deliver ${event.media.type} output`,
            );
          }
          const limit = this.options.maxOutboundMediaPerRun ?? 4;
          if (mediaOutputs.length >= limit) {
            throw new Error(
              `Agent media output exceeds per-run limit (${limit})`,
            );
          }
          mediaOutputs.push(event.media);
        } else if (event.type === "approval-requested") {
          await reply.close(
            `需要人工审批：${event.summary}\n审批编号：${event.approvalId}`,
          );
          closed = true;
        } else if (event.type === "failed") {
          throw new Error(event.message);
        }
      }
      if (!closed) await reply.close(projection.completed());
      for (const media of mediaOutputs) {
        await this.deliverMedia(message, media);
      }
      this.notifyLifecycle(
        message,
        "completed",
        this.now() - enqueuedAt,
        "enqueued",
        adapter.id,
      );
    } catch (error) {
      this.notifyRuntimeError(
        error instanceof Error ? error : new Error(String(error)),
      );
      await reply.close("Agent 处理失败，请稍后重试。");
      this.notifyLifecycle(
        message,
        "failed",
        this.now() - enqueuedAt,
        "enqueued",
        adapter.id,
      );
    } finally {
      await this.interruptRunApprovals(streamId);
      try {
        await releaseMedia();
      } catch (error) {
        this.notifyInfrastructureError({
          component: "transport",
          componentId: this.options.transport.id,
          operation: "release-media",
          error: asError(error),
        });
      }
    }
  }

  private async requestApproval(
    runId: string,
    message: InboundMessage,
    adapter: AgentRuntimeAdapter,
    reply: MutableReply,
    request: RuntimeApprovalRequest,
  ): Promise<RuntimeApprovalDecision> {
    const requestedAt = this.wallClock();
    const policyTimeoutMs = this.options.approvalTimeoutMs ?? 5 * 60_000;
    const runtimeTimeoutMs = request.maxWaitMs;
    if (
      runtimeTimeoutMs !== undefined &&
      (!Number.isInteger(runtimeTimeoutMs) || runtimeTimeoutMs < 1)
    ) {
      throw new Error("Runtime approval maxWaitMs must be a positive integer");
    }
    const timeoutMs = Math.min(
      policyTimeoutMs,
      runtimeTimeoutMs ?? policyTimeoutMs,
    );
    const approvalId = await this.createApprovalId({
      message,
      adapter,
      request,
      requestedAt,
      timeoutMs,
    });
    let resolveDecision!: (decision: RuntimeApprovalDecision) => void;
    const decision = new Promise<RuntimeApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void this.expireApproval(approvalId, message, resolveDecision);
    }, timeoutMs);
    this.approvalResolvers.set(approvalId, {
      resolve: resolveDecision,
      timer,
      requestedAt,
      conversationType: message.conversationType,
      toolName: request.toolName,
      effect: request.effect,
      runId,
      accountId: message.accountId,
      conversationId: message.conversationId,
      senderId: message.senderId,
    });
    this.notifyApprovalLifecycle({
      phase: "requested",
      conversationType: message.conversationType,
      toolName: request.toolName,
      effect: request.effect,
      elapsedMs: 0,
    });
    reply.update("⏸️ 等待人工审批，审批指令已作为独立消息发送。");
    try {
      await this.sendApprovalPrompt(
        message,
        approvalId,
        request.summary,
        timeoutMs,
      );
    } catch (error) {
      await this.interruptRunApprovals(runId);
      throw error;
    }
    return decision;
  }

  private async sendApprovalPrompt(
    message: InboundMessage,
    approvalId: string,
    summary: string,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.options.transport.capabilities.has("proactive-message")) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver a durable approval prompt`,
      );
    }
    await this.enqueueDurableDelivery(message.id, {
      type: "proactive",
      accountId: message.accountId,
      conversationId: message.conversationId,
      text: [
        "🔐 操作审批",
        summary,
        `请在 ${approvalWindow(timeoutMs)}内复制并发送：`,
        `/approve ${approvalId}`,
        "如需拒绝，请发送：",
        `/deny ${approvalId}`,
      ].join("\n"),
    });
  }

  private async createApprovalId(options: {
    message: InboundMessage;
    adapter: AgentRuntimeAdapter;
    request: RuntimeApprovalRequest;
    requestedAt: number;
    timeoutMs: number;
  }): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const approvalId = randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)
        .toUpperCase();
      let created: boolean;
      try {
        created = await this.options.store.createApproval({
          approvalId,
          accountId: options.message.accountId,
          conversationId: options.message.conversationId,
          senderId: options.message.senderId,
          adapterId: options.adapter.id,
          toolName: options.request.toolName,
          effect: options.request.effect,
          summary: options.request.summary,
          createdAt: new Date(options.requestedAt).toISOString(),
          expiresAt: new Date(
            options.requestedAt + options.timeoutMs,
          ).toISOString(),
        });
      } catch (error) {
        this.notifyApprovalStoreError("create-approval", error);
        throw error;
      }
      if (created) return approvalId;
    }
    throw new Error("Unable to allocate a unique approval code");
  }

  private async handleApprovalControl(
    message: InboundMessage,
    control: { approvalId: string; decision: "approved" | "denied" },
  ): Promise<void> {
    const now = this.wallClockIso();
    let resolved = false;
    try {
      resolved = await this.options.store.resolveApproval({
        approvalId: control.approvalId,
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        decision: control.decision,
        now,
      });
    } catch (error) {
      this.notifyApprovalStoreError("resolve-approval", error);
    }
    const pending = this.approvalResolvers.get(control.approvalId);
    if (resolved && pending) {
      clearTimeout(pending.timer);
      this.approvalResolvers.delete(control.approvalId);
      pending.resolve(control.decision);
      this.notifyApprovalLifecycle({
        phase: control.decision,
        conversationType: pending.conversationType,
        toolName: pending.toolName,
        effect: pending.effect,
        elapsedMs: this.wallClock() - pending.requestedAt,
      });
    }
    await this.reply(
      message,
      `approval-control-${message.id}`,
      resolved && pending
        ? control.decision === "approved"
          ? "✅ 已批准，继续执行。"
          : "⛔ 已拒绝，本次操作不会执行。"
        : "该审批不存在、已处理、已失效，或不属于当前会话与发送者。",
      true,
    );
  }

  private async expireApproval(
    approvalId: string,
    message: InboundMessage,
    resolve: (decision: RuntimeApprovalDecision) => void,
  ): Promise<void> {
    const pending = this.approvalResolvers.get(approvalId);
    if (!pending) return;
    let expired = false;
    try {
      expired = await this.options.store.resolveApproval({
        approvalId,
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        decision: "expired",
        now: this.wallClockIso(),
      });
    } catch (error) {
      this.notifyApprovalStoreError("resolve-approval", error);
      this.approvalResolvers.delete(approvalId);
      resolve("interrupted");
      this.notifyApprovalLifecycle({
        phase: "interrupted",
        conversationType: pending.conversationType,
        toolName: pending.toolName,
        effect: pending.effect,
        elapsedMs: this.wallClock() - pending.requestedAt,
      });
      return;
    }
    if (!expired) return;
    this.approvalResolvers.delete(approvalId);
    resolve("expired");
    this.notifyApprovalLifecycle({
      phase: "expired",
      conversationType: pending.conversationType,
      toolName: pending.toolName,
      effect: pending.effect,
      elapsedMs: this.wallClock() - pending.requestedAt,
    });
  }

  private async interruptApprovals(): Promise<void> {
    try {
      await this.options.store.interruptPendingApprovals(this.wallClockIso());
    } catch (error) {
      this.notifyApprovalStoreError("interrupt-approval", error);
    }
    for (const [approvalId, pending] of this.approvalResolvers) {
      clearTimeout(pending.timer);
      pending.resolve("interrupted");
      this.notifyApprovalLifecycle({
        phase: "interrupted",
        conversationType: pending.conversationType,
        toolName: pending.toolName,
        effect: pending.effect,
        elapsedMs: this.wallClock() - pending.requestedAt,
      });
      this.approvalResolvers.delete(approvalId);
    }
  }

  private async interruptRunApprovals(runId: string): Promise<void> {
    for (const [approvalId, pending] of this.approvalResolvers) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      try {
        await this.options.store.resolveApproval({
          approvalId,
          accountId: pending.accountId,
          conversationId: pending.conversationId,
          senderId: pending.senderId,
          decision: "interrupted",
          now: this.wallClockIso(),
        });
      } catch (error) {
        this.notifyApprovalStoreError("interrupt-approval", error);
      }
      this.approvalResolvers.delete(approvalId);
      pending.resolve("interrupted");
      this.notifyApprovalLifecycle({
        phase: "interrupted",
        conversationType: pending.conversationType,
        toolName: pending.toolName,
        effect: pending.effect,
        elapsedMs: this.wallClock() - pending.requestedAt,
      });
    }
  }

  private async reply(
    message: InboundMessage,
    streamId: string,
    text: string,
    final: boolean,
  ): Promise<boolean> {
    if (!message.replyReference)
      throw new Error("Inbound message has no reply reference");
    const command: DurableOutboundCommand = {
      type: "reply",
      accountId: message.accountId,
      conversationId: message.conversationId,
      replyReference: message.replyReference,
      streamId,
      text,
      final,
    };
    return this.enqueueDurableDelivery(
      message.id,
      command,
      `reply:${message.accountId}:${message.conversationId}:${streamId}`,
    );
  }

  private async enqueueDurableDelivery(
    messageId: string,
    command: DurableOutboundCommand,
    supersedeKey?: string,
  ): Promise<boolean> {
    const now = this.wallClock();
    let deliveryId: string;
    try {
      deliveryId = await this.options.store.enqueueDelivery({
        messageId,
        command,
        supersedeKey,
        now: iso(now),
      });
    } catch (error) {
      this.notifyInfrastructureError({
        component: "store",
        componentId: "gateway-store",
        operation: "enqueue-delivery",
        error: asError(error),
      });
      throw error;
    }
    this.notifyDeliveryLifecycle({
      phase: "enqueued",
      commandType: command.type,
      attempts: 0,
    });
    const claimed = await this.claimDelivery(deliveryId, now);
    return claimed ? this.dispatchSerialized(claimed) : false;
  }

  private async claimDelivery(
    deliveryId: string,
    now = this.wallClock(),
  ): Promise<DeliveryOutboxEntry | undefined> {
    try {
      return await this.options.store.claimDelivery({
        deliveryId,
        owner: this.deliveryOwner,
        now: iso(now),
        leaseUntil: iso(now + this.outboxLeaseMs()),
      });
    } catch (error) {
      this.notifyInfrastructureError({
        component: "store",
        componentId: "gateway-store",
        operation: "claim-delivery",
        error: asError(error),
      });
      return undefined;
    }
  }

  private async flushOutbox(): Promise<void> {
    const now = this.wallClock();
    let entries: DeliveryOutboxEntry[];
    try {
      entries = await this.options.store.claimDueDeliveries({
        owner: this.deliveryOwner,
        now: iso(now),
        leaseUntil: iso(now + this.outboxLeaseMs()),
        limit: this.options.outboxBatchSize ?? 10,
      });
    } catch (error) {
      this.notifyInfrastructureError({
        component: "store",
        componentId: "gateway-store",
        operation: "claim-delivery",
        error: asError(error),
      });
      return;
    }
    await Promise.all(entries.map((entry) => this.dispatchSerialized(entry)));
  }

  private async dispatchSerialized(
    entry: DeliveryOutboxEntry,
  ): Promise<boolean> {
    const key = `${entry.command.accountId}:${entry.command.conversationId}`;
    const previous = this.deliveryQueues.get(key) ?? Promise.resolve();
    let accepted = false;
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        accepted = await this.dispatchDelivery(entry);
      });
    this.deliveryQueues.set(key, current);
    try {
      await current;
      return accepted;
    } finally {
      if (this.deliveryQueues.get(key) === current) {
        this.deliveryQueues.delete(key);
      }
    }
  }

  private async dispatchDelivery(entry: DeliveryOutboxEntry): Promise<boolean> {
    let command: OutboundCommand;
    try {
      command = await this.outboundCommand(entry.command);
    } catch (error) {
      await this.settleFailedDelivery(entry, deliveryError(error));
      return false;
    }
    let receipt;
    try {
      receipt = await this.options.transport.deliver(command);
    } catch (error) {
      this.notifyInfrastructureError({
        component: "transport",
        componentId: this.options.transport.id,
        operation: "deliver",
        error: asError(error),
      });
      await this.settleFailedDelivery(entry, deliveryError(error));
      return false;
    }

    try {
      await this.options.store.completeDelivery({
        deliveryId: entry.id,
        owner: this.deliveryOwner,
        receipt,
        now: iso(this.wallClock()),
      });
      this.notifyDeliveryLifecycle({
        phase: "delivered",
        commandType: entry.command.type,
        attempts: entry.attempts,
      });
      await this.completeMediaArtifact(entry);
    } catch (error) {
      // The remote side may already have accepted the message. Leave the lease
      // intact so it can be recovered later with at-least-once semantics.
      this.notifyInfrastructureError({
        component: "store",
        componentId: "gateway-store",
        operation: "complete-delivery",
        error: asError(error),
      });
    }
    return true;
  }

  private async settleFailedDelivery(
    entry: DeliveryOutboxEntry,
    error: string,
  ): Promise<void> {
    const now = this.wallClock();
    if (entry.attempts >= (this.options.outboxMaxAttempts ?? 5)) {
      try {
        await this.options.store.deadLetterDelivery({
          deliveryId: entry.id,
          owner: this.deliveryOwner,
          error,
          now: iso(now),
        });
        this.notifyDeliveryLifecycle({
          phase: "dead-lettered",
          commandType: entry.command.type,
          attempts: entry.attempts,
        });
        await this.completeMediaArtifact(entry);
      } catch (storeError) {
        this.notifyInfrastructureError({
          component: "store",
          componentId: "gateway-store",
          operation: "dead-letter-delivery",
          error: asError(storeError),
        });
      }
      return;
    }

    const delay = Math.min(
      (this.options.outboxRetryBaseMs ?? 1_000) *
        2 ** Math.max(0, entry.attempts - 1),
      this.options.outboxRetryMaxMs ?? 30_000,
    );
    try {
      await this.options.store.retryDelivery({
        deliveryId: entry.id,
        owner: this.deliveryOwner,
        error,
        nextAttemptAt: iso(now + delay),
        now: iso(now),
      });
      this.notifyDeliveryLifecycle({
        phase: "retry-scheduled",
        commandType: entry.command.type,
        attempts: entry.attempts,
      });
    } catch (storeError) {
      this.notifyInfrastructureError({
        component: "store",
        componentId: "gateway-store",
        operation: "retry-delivery",
        error: asError(storeError),
      });
    }
  }

  private scheduleOutbox(delayMs: number): void {
    if (!this.started || this.stopping || this.outboxTimer) return;
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = undefined;
      const work = this.flushOutbox();
      this.activeOutboxFlush = work;
      void work.finally(() => {
        if (this.activeOutboxFlush === work) {
          this.activeOutboxFlush = undefined;
        }
        this.scheduleOutbox(this.options.outboxPollIntervalMs ?? 1_000);
      });
    }, delayMs);
    this.outboxTimer.unref?.();
  }

  private clearOutboxTimer(): void {
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = undefined;
  }

  private outboxLeaseMs(): number {
    return this.options.outboxLeaseMs ?? 30_000;
  }

  private async deliverMedia(
    message: InboundMessage,
    media: AgentMediaOutput,
  ): Promise<void> {
    await this.enqueueProactiveMedia(
      message.id,
      message.accountId,
      message.conversationId,
      media,
    );
  }

  private async enqueueProactiveMedia(
    messageId: string,
    accountId: string,
    conversationId: string,
    media: AgentMediaOutput,
  ): Promise<boolean> {
    const spool = this.options.mediaSpool;
    if (!spool) {
      throw new Error("Agent media output requires a durable media spool");
    }
    let artifact: DurableMediaArtifact;
    try {
      artifact = await spool.stage(media);
    } catch (error) {
      this.notifyInfrastructureError({
        component: "media-spool",
        componentId: spool.id,
        operation: "stage",
        error: asError(error),
      });
      throw error;
    }
    const command: DurableOutboundCommand = {
      type: "proactive-media",
      accountId,
      conversationId,
      media: artifact,
    };
    try {
      return await this.enqueueDurableDelivery(messageId, command);
    } catch (error) {
      await this.releaseMediaArtifact(artifact.artifactId);
      throw error;
    }
  }

  private async outboundCommand(
    command: DurableOutboundCommand,
  ): Promise<OutboundCommand> {
    if (command.type !== "proactive-media") return command;
    const spool = this.options.mediaSpool;
    if (!spool) throw new Error("Durable media delivery has no media spool");
    try {
      return {
        type: "proactive-media",
        accountId: command.accountId,
        conversationId: command.conversationId,
        media: await spool.materialize(command.media),
      };
    } catch (error) {
      this.notifyInfrastructureError({
        component: "media-spool",
        componentId: spool.id,
        operation: "materialize",
        error: asError(error),
      });
      throw error;
    }
  }

  private async completeMediaArtifact(
    entry: DeliveryOutboxEntry,
  ): Promise<void> {
    if (entry.command.type === "proactive-media") {
      await this.releaseMediaArtifact(entry.command.media.artifactId);
    }
  }

  private async releaseMediaArtifact(artifactId: string): Promise<void> {
    const spool = this.options.mediaSpool;
    if (!spool) return;
    try {
      await spool.release(artifactId);
    } catch (error) {
      this.notifyInfrastructureError({
        component: "media-spool",
        componentId: spool.id,
        operation: "release",
        error: asError(error),
      });
    }
  }

  private reserveInbound(
    conversationKey: string,
  ): BackpressureEvent["reason"] | undefined {
    if (
      this.pendingInboundMessages >=
      Math.max(1, this.options.maxPendingInboundMessages ?? 100)
    ) {
      return "global-limit";
    }
    const conversationPending =
      this.pendingByConversation.get(conversationKey) ?? 0;
    if (
      conversationPending >=
      Math.max(1, this.options.maxPendingInboundPerConversation ?? 10)
    ) {
      return "conversation-limit";
    }
    this.pendingInboundMessages += 1;
    this.pendingByConversation.set(conversationKey, conversationPending + 1);
    return undefined;
  }

  private releaseInbound(conversationKey: string): void {
    this.pendingInboundMessages = Math.max(0, this.pendingInboundMessages - 1);
    const remaining =
      (this.pendingByConversation.get(conversationKey) ?? 1) - 1;
    if (remaining <= 0) this.pendingByConversation.delete(conversationKey);
    else this.pendingByConversation.set(conversationKey, remaining);
  }

  private async withRunSlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireRunSlot();
    try {
      return await operation();
    } finally {
      this.releaseRunSlot();
    }
  }

  private async acquireRunSlot(): Promise<void> {
    if (this.activeRuns < Math.max(1, this.options.maxConcurrentRuns ?? 8)) {
      this.activeRuns += 1;
      return;
    }
    await new Promise<void>((resolve) => this.runWaiters.push(resolve));
  }

  private releaseRunSlot(): void {
    const next = this.runWaiters.shift();
    if (next) next();
    else this.activeRuns = Math.max(0, this.activeRuns - 1);
  }

  private notifyAccessDecision(event: {
    conversationType: InboundMessage["conversationType"];
    allowed: boolean;
    reason?: string;
  }): void {
    try {
      this.options.onAccessDecision?.(event);
    } catch {
      // Observability must never break the message path.
    }
  }

  private notifyRuntimeError(error: Error): void {
    try {
      this.options.onRuntimeError?.(error);
    } catch {
      // Observability must never break the message path.
    }
  }

  private notifyLifecycle(
    message: InboundMessage,
    phase: GatewayLifecycleEvent["phase"],
    elapsedMs: number,
    measuredFrom: GatewayLifecycleEvent["measuredFrom"],
    adapterId?: string,
  ): void {
    try {
      this.options.onLifecycleEvent?.({
        phase,
        conversationType: message.conversationType,
        adapterId,
        elapsedMs: Math.max(0, Math.round(elapsedMs)),
        measuredFrom,
      });
    } catch {
      // Observability must never break the message path.
    }
  }

  private notifyAdapterLifecycle(
    adapterId: string,
    phase: AdapterLifecycleEvent["phase"],
    elapsedMs: number,
  ): void {
    try {
      this.options.onAdapterLifecycleEvent?.({
        adapterId,
        phase,
        elapsedMs: Math.max(0, Math.round(elapsedMs)),
      });
    } catch {
      // Observability must never break adapter lifecycle.
    }
  }

  private notifyInfrastructureError(event: InfrastructureErrorEvent): void {
    try {
      this.options.onInfrastructureError?.(event);
    } catch {
      // Observability must never break infrastructure cleanup.
    }
  }

  private notifyDeliveryLifecycle(event: DeliveryLifecycleEvent): void {
    try {
      this.options.onDeliveryLifecycleEvent?.(event);
    } catch {
      // Observability must never break the delivery path.
    }
  }

  private notifyBackpressure(event: BackpressureEvent): void {
    try {
      this.options.onBackpressureEvent?.(event);
    } catch {
      // Observability must never break overload handling.
    }
  }

  private notifyApprovalLifecycle(event: ApprovalLifecycleEvent): void {
    try {
      this.options.onApprovalLifecycleEvent?.({
        ...event,
        elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
      });
    } catch {
      // Observability must never break approval handling.
    }
  }

  private notifyApprovalStoreError(
    operation: "create-approval" | "resolve-approval" | "interrupt-approval",
    error: unknown,
  ): void {
    this.notifyInfrastructureError({
      component: "store",
      componentId: "gateway-store",
      operation,
      error: asError(error),
    });
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private wallClock(): number {
    return this.options.wallClock?.() ?? Date.now();
  }

  private wallClockIso(): string {
    return new Date(this.wallClock()).toISOString();
  }

  private assertProactiveReady(): void {
    if (!this.started || this.stopping) {
      throw new Error("Gateway is not accepting proactive commands");
    }
    if (!this.options.transport.capabilities.has("proactive-message")) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver proactive messages`,
      );
    }
  }
}

function assertOpaqueTarget(value: string, label: string): void {
  if (!value || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid proactive ${label}`);
  }
}

function emptyOutboxStats(): GatewayOperationalSnapshot["outbox"] {
  return { pending: 0, leased: 0, delivered: 0, dead: 0, superseded: 0 };
}

function assertInboundModalities(
  transport: ChannelTransport,
  adapter: AgentRuntimeAdapter,
  message: InboundMessage,
): void {
  const mediaTypes = new Set<MediaType>();
  for (const part of message.parts) {
    if (part.type !== "text") mediaTypes.add(part.type);
  }
  if (mediaTypes.size === 0) return;
  if (!adapter.capabilities.has("multimodal-input")) {
    throw new Error(`Adapter ${adapter.id} cannot accept media input`);
  }
  for (const type of mediaTypes) {
    if (transport.inputModalities && !transport.inputModalities.has(type)) {
      throw new Error(
        `Transport ${transport.id} cannot materialize ${type} input`,
      );
    }
    if (adapter.inputModalities && !adapter.inputModalities.has(type)) {
      throw new Error(`Adapter ${adapter.id} cannot accept ${type} input`);
    }
  }
}

function parseApprovalControl(
  message: InboundMessage,
): { approvalId: string; decision: "approved" | "denied" } | undefined {
  if (message.parts.length !== 1 || message.parts[0]?.type !== "text") {
    return undefined;
  }
  const match = /^\/(approve|deny)\s+([A-F0-9]{8})$/i.exec(
    message.parts[0].text.trim(),
  );
  if (!match) return undefined;
  return {
    approvalId: match[2]!.toUpperCase(),
    decision: match[1]!.toLowerCase() === "approve" ? "approved" : "denied",
  };
}

function approvalWindow(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `${minutes} 分钟`
    : `${minutes} 分 ${remainingSeconds} 秒`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function deliveryError(error: unknown): string {
  return asError(error).message.slice(0, 1_000);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
