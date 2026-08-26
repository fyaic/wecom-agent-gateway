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
  type InboundInteraction,
  type InboundMessage,
  type InboundPolicy,
  type MediaSpool,
  type MediaType,
  type OutboundCommand,
  type PendingRuntimeInteraction,
  type Presentation,
  type RuntimeApprovalDecision,
  type RuntimeApprovalRequest,
  type RuntimeInteractionAction,
  type RuntimeInteractionRequest,
  type RuntimeInteractionResult,
  type RuntimeInteractionResumeEntry,
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
  onInteractionLifecycleEvent?: (event: InteractionLifecycleEvent) => void;
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
  interactionTimeoutMs?: number;
  /** Optional safe, operator-defined actions attached to each final Agent reply. */
  replyActions?: RuntimeInteractionAction[];
  replyActionTimeoutMs?: number;
  /** Show a scoped cancel card after this many milliseconds; unset disables it. */
  runControlAfterMs?: number;
  runControlTimeoutMs?: number;
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

/** Adapter-neutral request to suspend a session on a durable human interaction. */
export interface RuntimeInteractionStartRequest {
  accountId: string;
  conversationId: string;
  conversationType: InboundMessage["conversationType"];
  senderId: string;
  adapterId: string;
  sessionId: string;
  interaction: RuntimeInteractionRequest;
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
    | "cancelled"
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
    | "create-interaction"
    | "resolve-interaction"
    | "create-run-control"
    | "resolve-run-control"
    | "complete-run-control"
    | "create-runtime-interaction"
    | "resolve-runtime-interaction"
    | "cancel-runtime-interaction"
    | "expire-runtime-interaction"
    | "claim-interaction-resume"
    | "complete-interaction-resume"
    | "retry-interaction-resume"
    | "dead-letter-interaction-resume"
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

export interface InteractionLifecycleEvent {
  phase:
    | "requested"
    | "submitted"
    | "cancelled"
    | "resume-started"
    | "resume-delivered"
    | "resume-retry"
    | "resume-dead";
  conversationType: InboundMessage["conversationType"];
  kind: RuntimeInteractionRequest["kind"];
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

interface ActiveRunControlState {
  cancelRequested: boolean;
  finished: boolean;
  cancel(): Promise<void>;
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
  private readonly activeRunControls = new Map<string, ActiveRunControlState>();
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
    if (options.replyActions?.length) {
      validateRuntimeInteractionRequest({
        kind: "actions",
        title: "接下来",
        actions: options.replyActions,
        resumeMode: "new-turn",
      });
    }
    for (const [name, value] of [
      ["runControlAfterMs", options.runControlAfterMs],
      ["runControlTimeoutMs", options.runControlTimeoutMs],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new Error(`Gateway ${name} must be a positive integer`);
      }
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

  async startRuntimeInteraction(
    request: RuntimeInteractionStartRequest,
  ): Promise<string> {
    this.assertProactiveReady();
    if (
      request.interaction.kind !== "text-input" &&
      (!this.options.transport.capabilities.has("structured-presentation") ||
        !this.options.transport.capabilities.has("interactive-presentation"))
    ) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver interactive presentations`,
      );
    }
    const adapter = this.adapters.get(request.adapterId);
    if (!adapter) {
      throw new Error(`Runtime adapter not found: ${request.adapterId}`);
    }
    if (
      !adapter.capabilities.has("interaction-resume") ||
      !adapter.resumeInteraction
    ) {
      throw new Error(
        `Adapter ${adapter.id} cannot resume durable interactions`,
      );
    }
    assertOpaqueTarget(request.accountId, "accountId");
    assertOpaqueTarget(request.conversationId, "conversationId");
    assertOpaqueTarget(request.senderId, "senderId");
    assertOpaqueTarget(request.sessionId, "sessionId");
    validateRuntimeInteractionRequest(request.interaction);

    const policyTimeoutMs = this.options.interactionTimeoutMs ?? 5 * 60_000;
    if (!Number.isInteger(policyTimeoutMs) || policyTimeoutMs < 1) {
      throw new Error(
        "Gateway interactionTimeoutMs must be a positive integer",
      );
    }
    const timeoutMs = Math.min(
      policyTimeoutMs,
      request.interaction.expiresInMs ?? policyTimeoutMs,
    );
    const now = this.wallClock();
    const interactionId = `interaction_${randomUUID().replaceAll("-", "")}`;
    const pending: PendingRuntimeInteraction = {
      interactionId,
      accountId: request.accountId,
      conversationId: request.conversationId,
      conversationType: request.conversationType,
      senderId: request.senderId,
      adapterId: adapter.id,
      sessionId: request.sessionId,
      request: request.interaction,
      createdAt: iso(now),
      expiresAt: iso(now + timeoutMs),
    };

    try {
      const created =
        await this.options.store.createRuntimeInteraction(pending);
      if (!created) {
        throw new Error(
          "This conversation already has an active runtime interaction",
        );
      }
    } catch (error) {
      this.notifyInteractionStoreError("create-runtime-interaction", error);
      throw error;
    }

    try {
      await this.enqueueDurableDelivery(
        interactionId,
        request.interaction.kind === "text-input"
          ? {
              type: "proactive",
              accountId: request.accountId,
              conversationId: request.conversationId,
              text: textInteractionPrompt(request.interaction),
            }
          : {
              type: "proactive-presentation",
              accountId: request.accountId,
              conversationId: request.conversationId,
              presentation: interactionPresentation(
                interactionId,
                request.interaction,
              ),
            },
      );
    } catch (error) {
      try {
        await this.options.store.cancelRuntimeInteraction({
          interactionId,
          now: this.wallClockIso(),
        });
      } catch (cancelError) {
        this.notifyInteractionStoreError(
          "cancel-runtime-interaction",
          cancelError,
        );
      }
      throw error;
    }
    this.notifyInteractionLifecycle({
      phase: "requested",
      conversationType: request.conversationType,
      kind: request.interaction.kind,
      elapsedMs: 0,
    });
    return interactionId;
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
    if (message.interaction) {
      if (!(await this.options.store.acceptInbound(message))) return;
      if (await this.handleRunControl(message)) return;
      await this.handlePresentationInteraction(message);
      return;
    }
    const approvalControl = parseApprovalControl(message);
    if (approvalControl) {
      if (!(await this.options.store.acceptInbound(message))) return;
      await this.handleApprovalControl(message, approvalControl);
      return;
    }
    if (await this.tryHandleTextInteraction(message)) return;
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

  private async tryHandleTextInteraction(
    message: InboundMessage,
  ): Promise<boolean> {
    let pending: PendingRuntimeInteraction | undefined;
    try {
      pending = await this.options.store.getPendingRuntimeTextInteraction({
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        now: this.wallClockIso(),
      });
    } catch (error) {
      this.notifyInteractionStoreError("resolve-runtime-interaction", error);
      if (await this.options.store.acceptInbound(message).catch(() => false)) {
        await this.reply(
          message,
          `interaction-text-store-${message.id}`,
          "服务暂时无法确认交互状态，请稍后重试。",
          true,
        );
      }
      return true;
    }
    if (!pending || pending.request.kind !== "text-input") return false;
    if (!(await this.options.store.acceptInbound(message))) return true;

    const part = message.parts.length === 1 ? message.parts[0] : undefined;
    if (
      part?.type !== "text" ||
      !part.text.trim() ||
      Buffer.byteLength(part.text, "utf8") >
        (this.options.maxProactiveTextBytes ?? 20_000)
    ) {
      await this.reply(
        message,
        `interaction-text-invalid-${message.id}`,
        "当前交互需要一条非空纯文本回复，请重新发送。",
        true,
      );
      return true;
    }

    const submittedAt = this.wallClockIso();
    const result: RuntimeInteractionResult = {
      interactionId: pending.interactionId,
      status: "submitted",
      values: { [pending.request.fieldId]: [part.text] },
      submittedAt,
    };
    let resumeId: string | undefined;
    try {
      resumeId = await this.options.store.resolveRuntimeInteractionAndEnqueue({
        interactionId: pending.interactionId,
        accountId: pending.accountId,
        conversationId: pending.conversationId,
        senderId: pending.senderId,
        result,
        now: submittedAt,
      });
    } catch (error) {
      this.notifyInteractionStoreError("resolve-runtime-interaction", error);
    }
    await this.reply(
      message,
      `interaction-text-${message.id}`,
      resumeId ? "✅ 已提交，正在继续。" : "该交互已处理、已失效，或不再可用。",
      true,
    );
    if (!resumeId) return true;
    this.notifyInteractionLifecycle({
      phase: "submitted",
      conversationType: pending.conversationType,
      kind: pending.request.kind,
      elapsedMs:
        new Date(submittedAt).getTime() - new Date(pending.createdAt).getTime(),
    });
    this.clearOutboxTimer();
    this.scheduleOutbox(0);
    return true;
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
    let activeSessionId = sessionId;
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
          update.presentation,
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
    const runControlState: ActiveRunControlState = {
      cancelRequested: false,
      finished: false,
      cancel: async () => undefined,
    };
    let runControlId: string | undefined;
    let runControlTimer: ReturnType<typeof setTimeout> | undefined;
    let runControlCreation: Promise<string | undefined> | undefined;
    let runControlSuspended = false;

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
      const suspendRunControl = () => {
        runControlSuspended = true;
        if (runControlTimer) clearTimeout(runControlTimer);
        runControlTimer = undefined;
      };
      const scheduleRunControl = () => {
        if (
          runControlTimer ||
          runControlId ||
          runControlCreation ||
          runControlSuspended ||
          runControlState.finished ||
          !activeSessionId ||
          this.options.runControlAfterMs === undefined ||
          !adapter.capabilities.has("cancel") ||
          !adapter.cancel ||
          !this.options.transport.capabilities.has("structured-presentation") ||
          !this.options.transport.capabilities.has(
            "interactive-presentation",
          ) ||
          !this.options.transport.capabilities.has("proactive-message")
        ) {
          return;
        }
        const remaining = Math.max(
          0,
          kernelStartedAt + this.options.runControlAfterMs - this.now(),
        );
        const controlSessionId = activeSessionId;
        runControlState.cancel = async () => {
          if (runControlState.finished) return;
          await adapter.cancel!(controlSessionId);
        };
        runControlTimer = setTimeout(() => {
          runControlTimer = undefined;
          if (runControlState.finished || runControlSuspended) return;
          runControlCreation = this.presentRunControl({
            message,
            state: runControlState,
          }).catch((error: unknown) => {
            this.notifyInfrastructureError({
              component: "store",
              componentId: "gateway-store",
              operation: "create-run-control",
              error: asError(error),
            });
            return undefined;
          });
          void runControlCreation;
        }, remaining);
      };
      scheduleRunControl();
      let sawKernelEvent = false;
      let sawKernelText = false;
      let approvalQueue = Promise.resolve();
      for await (const event of adapter.run({
        message: materialized.message,
        sessionId,
        requestApproval: (request) => {
          suspendRunControl();
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
        if (runControlState.cancelRequested) continue;
        if (event.type === "session-started") {
          activeSessionId = event.sessionId;
          await this.options.store.setSession({
            ...scope,
            sessionId: event.sessionId,
          });
          scheduleRunControl();
        } else if (event.type === "status" || event.type === "text-delta") {
          const text = projection.apply(event);
          if (text !== undefined) reply.update(text);
        } else if (event.type === "interaction-requested") {
          suspendRunControl();
          if (!activeSessionId) {
            throw new Error(
              `Adapter ${adapter.id} requested interaction before starting a session`,
            );
          }
          await this.startRuntimeInteraction({
            accountId: message.accountId,
            conversationId: message.conversationId,
            conversationType: message.conversationType,
            senderId: message.senderId,
            adapterId: adapter.id,
            sessionId: activeSessionId,
            interaction: event.request,
          });
          reply.update("⏸️ 等待用户输入，交互请求已作为独立消息发送。");
        } else if (event.type === "message-completed") {
          await this.closeReplyWithActions({
            reply,
            message,
            adapter,
            sessionId: activeSessionId,
            text: projection.completed(event.text),
            actions: event.actions,
          });
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
      if (!closed) {
        if (runControlState.cancelRequested) {
          await reply.close("⏹️ 任务已停止。");
        } else {
          await this.closeReplyWithActions({
            reply,
            message,
            adapter,
            sessionId: activeSessionId,
            text: projection.completed(),
          });
        }
      }
      if (!runControlState.cancelRequested) {
        for (const media of mediaOutputs) {
          await this.deliverMedia(message, media);
        }
      }
      this.notifyLifecycle(
        message,
        runControlState.cancelRequested ? "cancelled" : "completed",
        this.now() - enqueuedAt,
        "enqueued",
        adapter.id,
      );
    } catch (error) {
      if (runControlState.cancelRequested) {
        await reply.close("⏹️ 任务已停止。");
      } else {
        this.notifyRuntimeError(
          error instanceof Error ? error : new Error(String(error)),
        );
        await reply.close("Agent 处理失败，请稍后重试。");
      }
      this.notifyLifecycle(
        message,
        runControlState.cancelRequested ? "cancelled" : "failed",
        this.now() - enqueuedAt,
        "enqueued",
        adapter.id,
      );
    } finally {
      runControlState.finished = true;
      if (runControlTimer) clearTimeout(runControlTimer);
      runControlId ??= await runControlCreation;
      if (runControlId) {
        this.activeRunControls.delete(runControlId);
        await this.options.store
          .completeRunControl({
            controlId: runControlId,
            now: this.wallClockIso(),
          })
          .catch((error: unknown) =>
            this.notifyInteractionStoreError("complete-run-control", error),
          );
      }
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
    if (
      this.options.transport.capabilities.has("structured-presentation") &&
      this.options.transport.capabilities.has("interactive-presentation")
    ) {
      const interactionId = `approval_${randomUUID().replaceAll("-", "")}`;
      const createdAt = this.wallClockIso();
      try {
        const created = await this.options.store.createPresentationInteraction({
          interactionId,
          accountId: message.accountId,
          conversationId: message.conversationId,
          senderId: message.senderId,
          kind: "approval",
          correlationId: approvalId,
          createdAt,
          expiresAt: new Date(
            new Date(createdAt).getTime() + timeoutMs,
          ).toISOString(),
        });
        if (!created) throw new Error("Unable to allocate card interaction");
      } catch (error) {
        this.notifyInfrastructureError({
          component: "store",
          componentId: "gateway-store",
          operation: "create-interaction",
          error: asError(error),
        });
        throw error;
      }
      await this.enqueueDurableDelivery(message.id, {
        type: "proactive-presentation",
        accountId: message.accountId,
        conversationId: message.conversationId,
        presentation: {
          kind: "actions",
          id: interactionId,
          title: "🔐 操作审批",
          body: `${cardExcerpt(summary, 80)}\n请在 ${approvalWindow(timeoutMs)}内选择。`,
          actions: [
            { id: "approve", label: "批准", style: "primary" },
            { id: "deny", label: "拒绝", style: "danger" },
          ],
        },
      });
      return;
    }
    await this.enqueueDurableDelivery(
      message.id,
      approvalFallbackCommand(message, approvalId, summary, timeoutMs),
    );
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
    const resolved = await this.resolveApprovalDecision(
      message,
      control.approvalId,
      control.decision,
    );
    await this.reply(
      message,
      `approval-control-${message.id}`,
      resolved
        ? control.decision === "approved"
          ? "✅ 已批准，继续执行。"
          : "⛔ 已拒绝，本次操作不会执行。"
        : "该审批不存在、已处理、已失效，或不属于当前会话与发送者。",
      true,
    );
  }

  private async presentRunControl(options: {
    message: InboundMessage;
    state: ActiveRunControlState;
  }): Promise<string> {
    if (options.state.finished || options.state.cancelRequested) {
      throw new Error("Agent run ended before its control card was created");
    }
    const now = this.wallClock();
    const timeoutMs = this.options.runControlTimeoutMs ?? 5 * 60_000;
    const controlId = `run_control_${randomUUID().replaceAll("-", "")}`;
    const created = await this.options.store.createRunControl({
      controlId,
      accountId: options.message.accountId,
      conversationId: options.message.conversationId,
      senderId: options.message.senderId,
      createdAt: iso(now),
      expiresAt: iso(now + timeoutMs),
    });
    if (!created) throw new Error("Unable to allocate a run control card");
    this.activeRunControls.set(controlId, options.state);
    try {
      await this.enqueueDurableDelivery(controlId, {
        type: "proactive-presentation",
        accountId: options.message.accountId,
        conversationId: options.message.conversationId,
        presentation: {
          kind: "actions",
          id: controlId,
          title: "⏳ 任务仍在执行",
          body: "可以继续等待；如不再需要，可停止当前任务。",
          actions: [{ id: "cancel", label: "停止任务", style: "danger" }],
        },
      });
    } catch (error) {
      this.activeRunControls.delete(controlId);
      await this.options.store.completeRunControl({
        controlId,
        now: this.wallClockIso(),
      });
      throw error;
    }
    this.notifyInteractionLifecycle({
      phase: "requested",
      conversationType: options.message.conversationType,
      kind: "actions",
      elapsedMs: 0,
    });
    return controlId;
  }

  private async handleRunControl(message: InboundMessage): Promise<boolean> {
    const inbound = message.interaction!;
    if (!inbound.presentationId.startsWith("run_control_")) return false;
    if (inbound.actionId !== "cancel") {
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "操作无效，请返回原卡片重试。",
      );
      return true;
    }
    const active = this.activeRunControls.get(inbound.presentationId);
    let resolved;
    try {
      resolved = await this.options.store.resolveRunControl({
        controlId: inbound.presentationId,
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        actionId: "cancel",
        now: this.wallClockIso(),
      });
    } catch (error) {
      this.notifyInteractionStoreError("resolve-run-control", error);
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "服务暂时无法确认停止操作，请稍后重试。",
      );
      return true;
    }
    // IDs in this namespace are one-shot. Completed, expired, duplicate, and
    // post-restart callbacks stay silent so WeCom does not render duplicate
    // result cards for one physical control card.
    if (!resolved) return true;
    await this.updateInteraction(
      message,
      inbound.presentationId,
      resolved.active && active
        ? "⏹️ 正在停止当前任务。"
        : "任务已经结束，无需停止。",
    );
    if (!resolved.active || !active || active.finished) return true;
    active.cancelRequested = true;
    try {
      await active.cancel();
      this.notifyInteractionLifecycle({
        phase: "cancelled",
        conversationType: message.conversationType,
        kind: "actions",
        elapsedMs: 0,
      });
    } catch (error) {
      active.cancelRequested = false;
      this.notifyRuntimeError(asError(error));
      await this.enqueueDurableDelivery(message.id, {
        type: "proactive",
        accountId: message.accountId,
        conversationId: message.conversationId,
        text: "停止请求失败，当前任务可能仍在执行。",
      });
    }
    return true;
  }

  private async handlePresentationInteraction(
    message: InboundMessage,
  ): Promise<void> {
    if (await this.handleRuntimeInteraction(message)) return;
    const interaction = message.interaction!;
    const action =
      interaction.actionId === "approve"
        ? "approved"
        : interaction.actionId === "deny"
          ? "denied"
          : undefined;
    let interactionRecord;
    if (action) {
      try {
        interactionRecord =
          await this.options.store.resolvePresentationInteraction({
            interactionId: interaction.presentationId,
            accountId: message.accountId,
            conversationId: message.conversationId,
            senderId: message.senderId,
            actionId: interaction.actionId!,
            now: this.wallClockIso(),
          });
      } catch (error) {
        this.notifyInfrastructureError({
          component: "store",
          componentId: "gateway-store",
          operation: "resolve-interaction",
          error: asError(error),
        });
      }
    }
    const resolved =
      interactionRecord?.kind === "approval" && action
        ? await this.resolveApprovalDecision(
            message,
            interactionRecord.correlationId,
            action,
          )
        : false;
    const text = resolved
      ? action === "approved"
        ? "✅ 已批准，继续执行。"
        : "⛔ 已拒绝，本次操作不会执行。"
      : "该操作不存在、已处理、已失效，或不属于当前会话与发送者。";
    await this.updateInteraction(message, interaction.presentationId, text);
  }

  private async handleRuntimeInteraction(
    message: InboundMessage,
  ): Promise<boolean> {
    const inbound = message.interaction!;
    let pending: PendingRuntimeInteraction | undefined;
    try {
      pending = await this.options.store.getPendingRuntimeInteraction({
        interactionId: inbound.presentationId,
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        now: this.wallClockIso(),
      });
    } catch (error) {
      this.notifyInteractionStoreError("resolve-runtime-interaction", error);
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "服务暂时无法确认本次操作，请稍后重试。",
      );
      return true;
    }
    // Runtime interaction IDs are Gateway-owned. Once one has resolved,
    // expired, or been replaced, duplicate callbacks must be silent: replying
    // with another update creates duplicate result cards in real WeCom
    // clients. Approval cards use a separate approval_ namespace and still
    // fall through to their own resolver below.
    if (!pending) return inbound.presentationId.startsWith("interaction_");

    const parsed = runtimeInteractionResult(
      pending,
      inbound,
      this.wallClockIso(),
    );
    if (!parsed) {
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "提交内容无效，请返回原卡片重新选择。",
      );
      return true;
    }

    let resumeId: string | undefined;
    try {
      resumeId = await this.options.store.resolveRuntimeInteractionAndEnqueue({
        interactionId: pending.interactionId,
        accountId: pending.accountId,
        conversationId: pending.conversationId,
        senderId: pending.senderId,
        result: parsed.result,
        now: parsed.result.submittedAt,
      });
    } catch (error) {
      this.notifyInteractionStoreError("resolve-runtime-interaction", error);
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "服务暂时无法保存本次操作，请稍后重试。",
      );
      return true;
    }
    if (!resumeId) {
      await this.updateInteraction(
        message,
        inbound.presentationId,
        "该操作已处理、已失效，或不再可用。",
      );
      return true;
    }

    // WeCom requires the callback card to be updated within five seconds. The
    // durable resume has already been committed, so acknowledge the user before
    // scheduling any Agent work.
    await this.updateInteraction(
      message,
      inbound.presentationId,
      parsed.result.status === "cancelled"
        ? "已取消。"
        : `✅ 已提交：${parsed.summary}`,
    );
    this.notifyInteractionLifecycle({
      phase: parsed.result.status === "cancelled" ? "cancelled" : "submitted",
      conversationType: pending.conversationType,
      kind: pending.request.kind,
      elapsedMs:
        new Date(parsed.result.submittedAt).getTime() -
        new Date(pending.createdAt).getTime(),
    });
    this.clearOutboxTimer();
    this.scheduleOutbox(0);
    return true;
  }

  private async resolveApprovalDecision(
    message: InboundMessage,
    approvalId: string,
    decision: "approved" | "denied",
  ): Promise<boolean> {
    let resolved = false;
    try {
      resolved = await this.options.store.resolveApproval({
        approvalId,
        accountId: message.accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        decision,
        now: this.wallClockIso(),
      });
    } catch (error) {
      this.notifyApprovalStoreError("resolve-approval", error);
    }
    const pending = this.approvalResolvers.get(approvalId);
    if (!resolved || !pending) return false;
    clearTimeout(pending.timer);
    this.approvalResolvers.delete(approvalId);
    pending.resolve(decision);
    this.notifyApprovalLifecycle({
      phase: decision,
      conversationType: pending.conversationType,
      toolName: pending.toolName,
      effect: pending.effect,
      elapsedMs: this.wallClock() - pending.requestedAt,
    });
    return true;
  }

  private async updateInteraction(
    message: InboundMessage,
    presentationId: string,
    text: string,
  ): Promise<void> {
    if (!message.replyReference) return;
    const command: OutboundCommand = {
      type: "interaction-update",
      accountId: message.accountId,
      conversationId: message.conversationId,
      replyReference: message.replyReference,
      presentation: {
        kind: "notice",
        id: presentationId,
        title: "操作结果",
        body: text,
      },
    };
    try {
      const receipt = await this.options.transport.deliver(command);
      await this.options.store.recordDelivery({
        messageId: message.id,
        command,
        receipt,
      });
    } catch (error) {
      this.notifyInfrastructureError({
        component: "transport",
        componentId: this.options.transport.id,
        operation: "deliver",
        error: asError(error),
      });
      try {
        await this.options.store.recordDelivery({
          messageId: message.id,
          command,
          error: asError(error).message,
        });
      } catch {
        // The approval decision is durable even when the five-second UI update
        // window or delivery journal is unavailable.
      }
    }
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

  private async closeReplyWithActions(options: {
    reply: MutableReply;
    message: InboundMessage;
    adapter: AgentRuntimeAdapter;
    sessionId?: string;
    text: string;
    actions?: RuntimeInteractionAction[];
  }): Promise<void> {
    const actions = options.actions ?? this.options.replyActions;
    if (!actions?.length) {
      await options.reply.close(options.text);
      return;
    }
    if (!options.adapter.capabilities.has("reply-actions")) {
      throw new Error(
        `Adapter ${options.adapter.id} emitted unsupported reply actions`,
      );
    }
    if (!options.sessionId) {
      throw new Error("Reply actions require a persistent Agent session");
    }
    const prepared = await this.prepareReplyActions({
      accountId: options.message.accountId,
      conversationId: options.message.conversationId,
      conversationType: options.message.conversationType,
      senderId: options.message.senderId,
      adapterId: options.adapter.id,
      sessionId: options.sessionId,
      actions,
    });
    try {
      await options.reply.close(options.text, prepared.presentation);
    } catch (error) {
      await this.options.store
        .cancelRuntimeInteraction({
          interactionId: prepared.interactionId,
          now: this.wallClockIso(),
        })
        .catch((cancelError: unknown) =>
          this.notifyInteractionStoreError(
            "cancel-runtime-interaction",
            cancelError,
          ),
        );
      throw error;
    }
  }

  private async prepareReplyActions(options: {
    accountId: string;
    conversationId: string;
    conversationType: InboundMessage["conversationType"];
    senderId: string;
    adapterId: string;
    sessionId: string;
    actions: RuntimeInteractionAction[];
  }): Promise<{ interactionId: string; presentation: Presentation }> {
    if (
      !this.options.transport.capabilities.has("structured-presentation") ||
      !this.options.transport.capabilities.has("interactive-presentation")
    ) {
      throw new Error(
        `Transport ${this.options.transport.id} cannot deliver reply actions`,
      );
    }
    const request: RuntimeInteractionRequest = {
      kind: "actions",
      title: "接下来",
      description: "选择一个快捷操作继续当前会话。",
      actions: options.actions,
      resumeMode: "new-turn",
    };
    validateRuntimeInteractionRequest(request);
    const timeoutMs = this.options.replyActionTimeoutMs ?? 24 * 60 * 60 * 1_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(
        "Gateway replyActionTimeoutMs must be a positive integer",
      );
    }
    const now = this.wallClock();
    const interactionId = `interaction_${randomUUID().replaceAll("-", "")}`;
    let created: boolean;
    try {
      created = await this.options.store.createRuntimeInteraction({
        interactionId,
        accountId: options.accountId,
        conversationId: options.conversationId,
        conversationType: options.conversationType,
        senderId: options.senderId,
        adapterId: options.adapterId,
        sessionId: options.sessionId,
        request,
        createdAt: iso(now),
        expiresAt: iso(now + timeoutMs),
      });
    } catch (error) {
      this.notifyInteractionStoreError("create-runtime-interaction", error);
      throw error;
    }
    if (!created) {
      throw new Error(
        "This conversation already has an active runtime interaction",
      );
    }
    return {
      interactionId,
      presentation: interactionPresentation(interactionId, request),
    };
  }

  private async reply(
    message: InboundMessage,
    streamId: string,
    text: string,
    final: boolean,
    presentation?: Presentation,
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
      ...(presentation ? { presentation } : {}),
    };
    if (presentation) {
      // The official combined stream only renders a template card reliably
      // when the card is present on the first reply frame. Final-answer
      // actions are not known until the Agent completes, so keep the mutable
      // text reply intact and send the card through the durable proactive
      // path immediately afterwards. A server success ack for adding a card
      // only on the final frame does not mean real clients display it.
      const textCommand: DurableOutboundCommand = {
        type: "reply",
        accountId: message.accountId,
        conversationId: message.conversationId,
        replyReference: message.replyReference,
        streamId,
        text,
        final,
      };
      const delivered = await this.enqueueDurableDelivery(
        message.id,
        textCommand,
        `reply:${message.accountId}:${message.conversationId}:${streamId}`,
      );
      const cardDelivered = await this.enqueueDurableDelivery(message.id, {
        type: "proactive-presentation",
        accountId: message.accountId,
        conversationId: message.conversationId,
        presentation,
      });
      return delivered && cardDelivered;
    }
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
    await Promise.all([this.flushDeliveries(), this.flushInteractionResumes()]);
  }

  private async flushDeliveries(): Promise<void> {
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

  private async flushInteractionResumes(): Promise<void> {
    const now = this.wallClock();
    try {
      await this.options.store.expireRuntimeInteractionsAndEnqueue({
        now: iso(now),
        limit: this.options.outboxBatchSize ?? 10,
      });
    } catch (error) {
      this.notifyInteractionStoreError("expire-runtime-interaction", error);
    }
    let entries: RuntimeInteractionResumeEntry[];
    try {
      entries = await this.options.store.claimDueInteractionResumes({
        owner: this.deliveryOwner,
        now: iso(now),
        leaseUntil: iso(now + this.outboxLeaseMs()),
        limit: this.options.outboxBatchSize ?? 10,
      });
    } catch (error) {
      this.notifyInteractionStoreError("claim-interaction-resume", error);
      return;
    }
    await Promise.all(
      entries.map((entry) => this.dispatchInteractionResumeSerialized(entry)),
    );
  }

  private async dispatchInteractionResumeSerialized(
    entry: RuntimeInteractionResumeEntry,
  ): Promise<void> {
    const adapter = this.adapters.get(entry.adapterId);
    const startsNewTurn =
      entry.request.kind === "actions" &&
      entry.request.resumeMode === "new-turn";
    if (
      !startsNewTurn &&
      adapter?.capabilities.has("interaction-live-resume")
    ) {
      await this.dispatchInteractionResume(entry);
      return;
    }
    const key = `${entry.accountId}:${entry.conversationId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () =>
        this.withRunSlot(() => this.dispatchInteractionResume(entry)),
      );
    this.queues.set(key, current);
    try {
      await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  private async dispatchInteractionResume(
    entry: RuntimeInteractionResumeEntry,
  ): Promise<void> {
    const adapter = this.adapters.get(entry.adapterId);
    const startedAt = this.wallClock();
    try {
      if (
        !adapter ||
        !adapter.capabilities.has("interaction-resume") ||
        !adapter.resumeInteraction
      ) {
        throw new Error(
          `Adapter ${entry.adapterId} cannot resume durable interactions`,
        );
      }
      this.notifyInteractionLifecycle({
        phase: "resume-started",
        conversationType: entry.conversationType,
        kind: entry.kind,
        elapsedMs: 0,
      });
      const projection = new AgentReplyProjection();
      let completedText: string | undefined;
      let completedActions: RuntimeInteractionAction[] | undefined;
      const mediaOutputs: AgentMediaOutput[] = [];
      for await (const event of adapter.resumeInteraction({
        sessionId: entry.sessionId,
        idempotencyKey: `interaction-resume:${entry.interactionId}`,
        interaction: entry.request,
        result: entry.result,
        message: interactionResumeMessage(entry),
      })) {
        if (event.type === "session-started") {
          await this.options.store.setSession({
            accountId: entry.accountId,
            conversationId: entry.conversationId,
            adapterId: adapter.sessionCompatibilityId ?? adapter.id,
            sessionId: event.sessionId,
          });
        } else if (event.type === "status" || event.type === "text-delta") {
          projection.apply(event);
        } else if (event.type === "message-completed") {
          completedText = projection.completed(event.text);
          completedActions = event.actions;
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
          throw new Error(
            "Approval requests are not supported while resuming an interaction",
          );
        } else if (event.type === "interaction-requested") {
          if (
            entry.request.kind === "actions" &&
            entry.request.resumeMode === "new-turn"
          ) {
            throw new Error(
              "Callback continuations cannot open live interactions",
            );
          }
          if (!adapter.capabilities.has("interaction-live-resume")) {
            throw new Error(
              `Adapter ${adapter.id} emitted a nested interaction without live resume`,
            );
          }
          await this.startRuntimeInteraction({
            accountId: entry.accountId,
            conversationId: entry.conversationId,
            conversationType: entry.conversationType,
            senderId: entry.senderId,
            adapterId: entry.adapterId,
            sessionId: entry.sessionId,
            interaction: event.request,
          });
        } else if (event.type === "failed") {
          throw new Error(event.message);
        }
      }
      completedText ??= projection.completed();
      if (completedText.trim()) {
        await this.enqueueDurableDelivery(
          entry.interactionId,
          {
            type: "proactive",
            accountId: entry.accountId,
            conversationId: entry.conversationId,
            text: completedText,
          },
          `interaction-resume:${entry.interactionId}:text`,
        );
      }
      // Operator defaults are a one-shot affordance for ordinary inbound
      // turns. Reattaching them to their own callback continuation would make
      // every click create another identical card and allow an unbounded loop.
      // An Adapter can still explicitly emit actions for a deliberate next
      // step in a multi-step interaction.
      const replyActions = completedActions;
      if (replyActions?.length) {
        if (!adapter.capabilities.has("reply-actions")) {
          throw new Error(
            `Adapter ${adapter.id} emitted unsupported reply actions`,
          );
        }
        const prepared = await this.prepareReplyActions({
          accountId: entry.accountId,
          conversationId: entry.conversationId,
          conversationType: entry.conversationType,
          senderId: entry.senderId,
          adapterId: entry.adapterId,
          sessionId: entry.sessionId,
          actions: replyActions,
        });
        await this.enqueueDurableDelivery(entry.interactionId, {
          type: "proactive-presentation",
          accountId: entry.accountId,
          conversationId: entry.conversationId,
          presentation: prepared.presentation,
        });
      }
      for (const media of mediaOutputs) {
        await this.enqueueProactiveMedia(
          entry.interactionId,
          entry.accountId,
          entry.conversationId,
          media,
        );
      }
      await this.options.store.completeInteractionResume({
        resumeId: entry.id,
        owner: this.deliveryOwner,
        now: this.wallClockIso(),
      });
      this.notifyInteractionLifecycle({
        phase: "resume-delivered",
        conversationType: entry.conversationType,
        kind: entry.kind,
        elapsedMs: this.wallClock() - startedAt,
      });
    } catch (error) {
      this.notifyRuntimeError(asError(error));
      await this.settleFailedInteractionResume(entry, asError(error).message);
    }
  }

  private async settleFailedInteractionResume(
    entry: RuntimeInteractionResumeEntry,
    error: string,
  ): Promise<void> {
    const now = this.wallClock();
    if (entry.attempts >= (this.options.outboxMaxAttempts ?? 5)) {
      try {
        await this.options.store.deadLetterInteractionResume({
          resumeId: entry.id,
          owner: this.deliveryOwner,
          error,
          now: iso(now),
        });
        this.notifyInteractionLifecycle({
          phase: "resume-dead",
          conversationType: entry.conversationType,
          kind: entry.kind,
          elapsedMs: 0,
        });
      } catch (storeError) {
        this.notifyInteractionStoreError(
          "dead-letter-interaction-resume",
          storeError,
        );
      }
      return;
    }
    const delay = Math.min(
      (this.options.outboxRetryBaseMs ?? 1_000) *
        2 ** Math.max(0, entry.attempts - 1),
      this.options.outboxRetryMaxMs ?? 30_000,
    );
    try {
      await this.options.store.retryInteractionResume({
        resumeId: entry.id,
        owner: this.deliveryOwner,
        error,
        nextAttemptAt: iso(now + delay),
        now: iso(now),
      });
      this.notifyInteractionLifecycle({
        phase: "resume-retry",
        conversationType: entry.conversationType,
        kind: entry.kind,
        elapsedMs: delay,
      });
    } catch (storeError) {
      this.notifyInteractionStoreError("retry-interaction-resume", storeError);
    }
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

  private notifyInteractionLifecycle(event: InteractionLifecycleEvent): void {
    try {
      this.options.onInteractionLifecycleEvent?.({
        ...event,
        elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
      });
    } catch {
      // Observability must never break interaction handling.
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

  private notifyInteractionStoreError(
    operation:
      | "create-runtime-interaction"
      | "resolve-runtime-interaction"
      | "cancel-runtime-interaction"
      | "create-run-control"
      | "resolve-run-control"
      | "complete-run-control"
      | "expire-runtime-interaction"
      | "claim-interaction-resume"
      | "complete-interaction-resume"
      | "retry-interaction-resume"
      | "dead-letter-interaction-resume",
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

function validateRuntimeInteractionRequest(
  request: RuntimeInteractionRequest,
): void {
  boundedRuntimeText(request.title, 200, "interaction title");
  if (request.description !== undefined) {
    boundedRuntimeText(request.description, 2_000, "interaction description");
  }
  if (
    request.expiresInMs !== undefined &&
    (!Number.isInteger(request.expiresInMs) || request.expiresInMs < 1)
  ) {
    throw new Error("Interaction expiresInMs must be a positive integer");
  }
  if (request.kind === "text-input") {
    boundedRuntimeId(request.fieldId, "fieldId");
    if (request.placeholder !== undefined) {
      boundedRuntimeText(request.placeholder, 500, "input placeholder");
    }
    if (request.initialValue !== undefined) {
      boundedRuntimeText(request.initialValue, 2_000, "initial value");
    }
    return;
  }
  if (request.kind === "confirm") {
    if (request.confirmLabel !== undefined) {
      boundedRuntimeText(request.confirmLabel, 40, "confirm label");
    }
    if (request.cancelLabel !== undefined) {
      boundedRuntimeText(request.cancelLabel, 40, "cancel label");
    }
    if (
      request.confirmStyle !== undefined &&
      request.confirmStyle !== "primary" &&
      request.confirmStyle !== "danger"
    ) {
      throw new Error("Invalid confirm style");
    }
    return;
  }
  if (request.kind === "actions") {
    validateRuntimeOptions(request.actions, 1, 6, "actions");
    if (
      request.resumeMode !== undefined &&
      request.resumeMode !== "elicitation" &&
      request.resumeMode !== "new-turn"
    ) {
      throw new Error("Invalid action resume mode");
    }
    return;
  }
  if (request.kind === "single-select") {
    boundedRuntimeId(request.fieldId, "fieldId");
    validateRuntimeOptions(request.options, 1, 20, "options");
    return;
  }
  if (request.kind === "multi-select") {
    boundedRuntimeId(request.fieldId, "fieldId");
    validateRuntimeOptions(request.options, 1, 20, "options");
    const min = request.min ?? 0;
    const max = request.max ?? request.options.length;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      min > max ||
      max > request.options.length
    ) {
      throw new Error("Invalid multi-select min/max bounds");
    }
    return;
  }
  if (request.fields.length < 1 || request.fields.length > 3) {
    throw new Error("Interaction forms require between 1 and 3 fields");
  }
  const fieldIds = new Set<string>();
  for (const field of request.fields) {
    boundedRuntimeId(field.id, "field id");
    if (fieldIds.has(field.id))
      throw new Error("Form field ids must be unique");
    fieldIds.add(field.id);
    boundedRuntimeText(field.label, 100, "field label");
    validateRuntimeOptions(field.options, 1, 10, "field options");
  }
  if (request.submitLabel !== undefined) {
    boundedRuntimeText(request.submitLabel, 40, "submit label");
  }
}

function validateRuntimeOptions(
  options: Array<{ value: string; label: string }>,
  min: number,
  max: number,
  label: string,
): void {
  if (options.length < min || options.length > max) {
    throw new Error(`Interaction ${label} require between ${min} and ${max}`);
  }
  const values = new Set<string>();
  for (const option of options) {
    boundedRuntimeId(option.value, "option value");
    if (values.has(option.value)) {
      throw new Error("Interaction option values must be unique");
    }
    values.add(option.value);
    boundedRuntimeText(option.label, 100, "option label");
    if (
      "style" in option &&
      option.style !== undefined &&
      option.style !== "default" &&
      option.style !== "primary" &&
      option.style !== "danger"
    ) {
      throw new Error("Invalid interaction action style");
    }
  }
}

function boundedRuntimeText(value: string, max: number, label: string): void {
  const length = [...value.trim()].length;
  if (length < 1 || length > max || /\0/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function boundedRuntimeId(value: string, label: string): void {
  if (!value || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function interactionPresentation(
  interactionId: string,
  request: RuntimeInteractionRequest,
): Presentation {
  if (request.kind === "text-input") {
    throw new Error("Text interactions do not use structured presentations");
  }
  const title = cardExcerpt(request.title, 26);
  const body = request.description
    ? cardExcerpt(request.description, 112)
    : undefined;
  if (request.kind === "confirm") {
    return {
      kind: "actions",
      id: interactionId,
      title,
      body,
      actions: [
        {
          id: "confirm",
          label: cardExcerpt(request.confirmLabel ?? "确认", 10),
          style: request.confirmStyle ?? "primary",
        },
        {
          id: "cancel",
          label: cardExcerpt(request.cancelLabel ?? "取消", 10),
          style: "default",
        },
      ],
    };
  }
  if (request.kind === "actions") {
    return {
      kind: "actions",
      id: interactionId,
      title,
      body,
      actions: request.actions.map((action, index) => ({
        id: `action_${index}`,
        label: cardExcerpt(action.label, 10),
        style: action.style ?? "default",
      })),
    };
  }
  if (request.kind === "single-select" || request.kind === "multi-select") {
    return {
      kind: "choice",
      id: interactionId,
      title,
      body,
      questionId: "choice",
      options: request.options.map((option, index) => ({
        id: `option_${index}`,
        label: option.label.trim(),
      })),
      multiple: request.kind === "multi-select",
    };
  }
  return {
    kind: "form",
    id: interactionId,
    title,
    body,
    fields: request.fields.map((field, fieldIndex) => ({
      id: `field_${fieldIndex}`,
      label: cardExcerpt(field.label, 13),
      options: field.options.map((option, optionIndex) => ({
        id: `option_${optionIndex}`,
        label: cardExcerpt(option.label, 10),
      })),
    })),
    submitId: "submit",
    submitLabel: request.submitLabel
      ? cardExcerpt(request.submitLabel, 10)
      : undefined,
  };
}

function runtimeInteractionResult(
  pending: PendingRuntimeInteraction,
  inbound: InboundInteraction,
  submittedAt: string,
): { result: RuntimeInteractionResult; summary: string } | undefined {
  const request = pending.request;
  const base = {
    interactionId: pending.interactionId,
    submittedAt,
  };
  if (request.kind === "confirm") {
    if (inbound.actionId === "cancel") {
      return {
        result: { ...base, status: "cancelled", values: {} },
        summary: request.cancelLabel ?? "取消",
      };
    }
    if (inbound.actionId !== "confirm") return undefined;
    return {
      result: {
        ...base,
        status: "submitted",
        values: { confirmation: ["confirmed"] },
      },
      summary: request.confirmLabel ?? "确认",
    };
  }
  if (request.kind === "actions") {
    const index = syntheticIndex(inbound.actionId, "action_", request.actions);
    if (index === undefined) return undefined;
    const action = request.actions[index]!;
    return {
      result: {
        ...base,
        status: "submitted",
        values: { action: [action.value] },
      },
      summary: action.label,
    };
  }
  if (request.kind === "single-select") {
    const selected = selectedSyntheticIndexes(
      inbound,
      "choice",
      request.options,
    );
    if (selected && selected.length !== 1) return undefined;
    const index = selected?.[0];
    if (index === undefined) return undefined;
    const option = request.options[index]!;
    return {
      result: {
        ...base,
        status: "submitted",
        values: { [request.fieldId]: [option.value] },
      },
      summary: option.label,
    };
  }
  if (request.kind === "multi-select") {
    const indexes = selectedSyntheticIndexes(
      inbound,
      "choice",
      request.options,
    );
    if (!indexes) return undefined;
    const min = request.min ?? 0;
    const max = request.max ?? request.options.length;
    if (indexes.length < min || indexes.length > max) return undefined;
    const selected = indexes.map((index) => request.options[index]!);
    return {
      result: {
        ...base,
        status: "submitted",
        values: { [request.fieldId]: selected.map((option) => option.value) },
      },
      summary: selected.length
        ? selected.map((option) => option.label).join("、")
        : "未选择",
    };
  }
  if (request.kind === "text-input") return undefined;
  const values: Record<string, string[]> = {};
  const labels: string[] = [];
  for (const [fieldIndex, field] of request.fields.entries()) {
    const indexes = selectedSyntheticIndexes(
      inbound,
      `field_${fieldIndex}`,
      field.options,
    );
    if (!indexes || indexes.length !== 1) return undefined;
    const option = field.options[indexes[0]!]!;
    values[field.id] = [option.value];
    labels.push(`${field.label}：${option.label}`);
  }
  return {
    result: { ...base, status: "submitted", values },
    summary: labels.join(" · "),
  };
}

function textInteractionPrompt(
  request: Extract<RuntimeInteractionRequest, { kind: "text-input" }>,
): string {
  const lines = [request.title];
  if (request.description) lines.push(request.description);
  if (request.initialValue) {
    lines.push(`当前内容：\n${request.initialValue}`);
  } else if (request.placeholder) {
    lines.push(`提示：${request.placeholder}`);
  }
  lines.push(
    request.multiline
      ? "请直接回复修改后的文本。"
      : "请直接回复一条纯文本消息。",
  );
  return lines.join("\n\n");
}

function interactionResumeMessage(
  entry: RuntimeInteractionResumeEntry,
): InboundMessage | undefined {
  if (
    entry.request.kind !== "actions" ||
    entry.request.resumeMode !== "new-turn" ||
    entry.result.status !== "submitted"
  ) {
    return undefined;
  }
  const value = entry.result.values.action;
  if (!value || value.length !== 1 || !value[0]?.trim()) {
    throw new Error("Reply action continuation has no action value");
  }
  const actionIndex = entry.request.actions.findIndex(
    (action) => action.value === value[0],
  );
  if (actionIndex < 0) {
    throw new Error("Reply action continuation value is not registered");
  }
  return {
    id: `reply-action-${entry.interactionId}`,
    accountId: entry.accountId,
    conversationId: entry.conversationId,
    conversationType: entry.conversationType,
    senderId: entry.senderId,
    receivedAt: entry.result.submittedAt,
    parts: [{ type: "text", text: value[0] }],
    interaction: {
      presentationId: entry.interactionId,
      actionId: `action_${actionIndex}`,
    },
    metadata: { source: "reply-action" },
  };
}

function syntheticIndex(
  id: string | undefined,
  prefix: string,
  items: readonly unknown[],
): number | undefined {
  if (!id?.startsWith(prefix)) return undefined;
  const raw = id.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return undefined;
  const index = Number(raw);
  return index >= 0 && index < items.length ? index : undefined;
}

function selectedSyntheticIndexes(
  inbound: InboundInteraction,
  fieldId: string,
  items: readonly unknown[],
): number[] | undefined {
  const selection = inbound.selections?.find(
    (candidate) => candidate.fieldId === fieldId,
  );
  if (!selection) return undefined;
  const indexes = selection.optionIds.map((optionId) =>
    syntheticIndex(optionId, "option_", items),
  );
  if (indexes.some((index) => index === undefined)) return undefined;
  return [...new Set(indexes as number[])];
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

function cardExcerpt(value: string, maxCharacters: number): string {
  const characters = [...value.trim()];
  return characters.length <= maxCharacters
    ? characters.join("")
    : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function approvalFallbackCommand(
  message: InboundMessage,
  approvalId: string,
  summary: string,
  timeoutMs: number,
): DurableOutboundCommand {
  return {
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
  };
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
