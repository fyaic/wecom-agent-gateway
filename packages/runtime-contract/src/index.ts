export type ConversationType = "direct" | "group";
export type MediaType = "image" | "audio" | "video" | "file";

/** Major version of the host/adapter boundary. Bump only for incompatible semantics. */
export const RUNTIME_CONTRACT_VERSION = 1 as const;
export type RuntimeContractVersion = typeof RUNTIME_CONTRACT_VERSION;

export type ChannelCapability =
  | "stream-reply-update"
  | "proactive-message"
  | "media-download"
  | "media-upload"
  | "multimodal-input"
  | "multimodal-output"
  | "structured-presentation"
  | "interactive-presentation";

export interface PresentationLink {
  label?: string;
  url: string;
}

export interface PresentationAction {
  id: string;
  label: string;
  style?: "default" | "primary" | "danger";
}

export interface PresentationOption {
  id: string;
  label: string;
}

/**
 * Channel-neutral structured content. Transports own vendor rendering and
 * validation; Kernels must never emit WeCom template-card JSON directly.
 */
export type Presentation =
  | {
      kind: "notice";
      id: string;
      title: string;
      body?: string;
      action?: PresentationLink;
    }
  | {
      kind: "article";
      id: string;
      title: string;
      description?: string;
      imageUrl: string;
      action: PresentationLink;
    }
  | {
      kind: "actions";
      id: string;
      title: string;
      body?: string;
      actions: PresentationAction[];
    }
  | {
      kind: "choice";
      id: string;
      title: string;
      body?: string;
      questionId: string;
      options: PresentationOption[];
      multiple?: boolean;
      submitLabel?: string;
    }
  | {
      kind: "form";
      id: string;
      title: string;
      body?: string;
      fields: Array<{
        id: string;
        label: string;
        options: PresentationOption[];
      }>;
      submitId: string;
      submitLabel?: string;
    };

export interface InboundInteraction {
  presentationId: string;
  actionId?: string;
  selections?: Array<{ fieldId: string; optionIds: string[] }>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: MediaType;
      /** Public URL accepted by a Kernel, or an ephemeral Channel URL before materialization. */
      url?: string;
      /** Protected local file created by the Channel and valid only for this run. */
      path?: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      /** Channel-only decryption material. It must not be persisted or sent to a Kernel. */
      aesKey?: string;
    };

export interface InboundMessage {
  id: string;
  accountId: string;
  conversationId: string;
  conversationType: ConversationType;
  senderId: string;
  receivedAt: string;
  parts: MessagePart[];
  interaction?: InboundInteraction;
  replyReference?: { requestId: string };
  metadata?: Record<string, unknown>;
}

export type OutboundCommand =
  | {
      type: "reply";
      accountId: string;
      conversationId: string;
      replyReference: { requestId: string };
      streamId: string;
      text: string;
      final: boolean;
    }
  | {
      type: "proactive";
      accountId: string;
      conversationId: string;
      text: string;
    }
  | {
      type: "proactive-media";
      accountId: string;
      conversationId: string;
      media: AgentMediaOutput;
    }
  | {
      type: "proactive-presentation";
      accountId: string;
      conversationId: string;
      presentation: Presentation;
    }
  | {
      /** Time-bound callback update; transports should attempt it immediately. */
      type: "interaction-update";
      accountId: string;
      conversationId: string;
      replyReference: { requestId: string };
      presentation: Presentation;
    };

export type DurableOutboundCommand =
  | Exclude<
      OutboundCommand,
      { type: "proactive-media" } | { type: "interaction-update" }
    >
  | {
      type: "proactive-media";
      accountId: string;
      conversationId: string;
      media: DurableMediaArtifact;
    };

export interface AgentMediaOutput {
  type: MediaType;
  /** Local file selected by the Agent adapter; the Channel applies its own root policy. */
  path: string;
  name?: string;
  mimeType?: string;
  title?: string;
  description?: string;
  /** Channel-controlled integrity metadata used after durable spooling. */
  sizeBytes?: number;
  sha256?: string;
}

export interface DurableMediaArtifact {
  artifactId: string;
  type: MediaType;
  name?: string;
  mimeType?: string;
  title?: string;
  description?: string;
  sizeBytes: number;
  sha256: string;
}

export interface MediaSpool {
  readonly id: string;
  start?(): Promise<void>;
  stage(media: AgentMediaOutput): Promise<DurableMediaArtifact>;
  materialize(artifact: DurableMediaArtifact): Promise<AgentMediaOutput>;
  release(artifactId: string): Promise<void>;
  reconcile(referencedArtifactIds: ReadonlySet<string>): Promise<void>;
}

export interface DeliveryReceipt {
  id: string;
  acceptedAt: string;
}

export interface MaterializedInboundMessage {
  message: InboundMessage;
  /** Release all ephemeral media resources. Safe to call more than once. */
  release(): Promise<void>;
}

export interface ChannelTransport {
  readonly id: string;
  readonly capabilities: ReadonlySet<ChannelCapability>;
  /** Exact inbound media types this transport can materialize. */
  readonly inputModalities?: ReadonlySet<MediaType>;
  /** Exact outbound media types this transport can upload and deliver. */
  readonly outputModalities?: ReadonlySet<MediaType>;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /** Resolve Channel-specific media into protected, runtime-neutral local files. */
  materializeInbound?(
    message: InboundMessage,
  ): Promise<MaterializedInboundMessage>;
  deliver(command: OutboundCommand): Promise<DeliveryReceipt>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export type RuntimeCapability =
  | "streaming"
  | "resume"
  | "cancel"
  | "approval"
  | "tools"
  | "status-events"
  | "multimodal-input"
  | "multimodal-output"
  | "interaction-resume"
  /** Resume is a control response to a still-live Kernel turn; bypass semantic turn queues. */
  | "interaction-live-resume";

export type AgentStatusPhase =
  | "accepted"
  | "queued"
  | "thinking"
  | "tool-running"
  | "waiting-approval"
  | "custom";

export interface AgentRunRequest {
  message: InboundMessage;
  sessionId?: string;
  requestApproval?: (
    request: RuntimeApprovalRequest,
  ) => Promise<RuntimeApprovalDecision>;
}

export interface RuntimeInteractionOption {
  value: string;
  label: string;
}

export interface RuntimeInteractionAction extends RuntimeInteractionOption {
  /** Visual intent is explicit; adapters and Core must never infer it from position. */
  style?: "default" | "primary" | "danger";
}

export interface RuntimeInteractionField {
  id: string;
  label: string;
  options: RuntimeInteractionOption[];
}

interface RuntimeInteractionRequestBase {
  title: string;
  description?: string;
  expiresInMs?: number;
}

export type RuntimeInteractionRequest =
  | (RuntimeInteractionRequestBase & {
      kind: "confirm";
      confirmLabel?: string;
      cancelLabel?: string;
      confirmStyle?: "primary" | "danger";
    })
  | (RuntimeInteractionRequestBase & {
      kind: "single-select";
      fieldId: string;
      options: RuntimeInteractionOption[];
    })
  | (RuntimeInteractionRequestBase & {
      kind: "multi-select";
      fieldId: string;
      options: RuntimeInteractionOption[];
      min?: number;
      max?: number;
    })
  | (RuntimeInteractionRequestBase & {
      kind: "form";
      fields: RuntimeInteractionField[];
      submitLabel?: string;
    })
  | (RuntimeInteractionRequestBase & {
      kind: "actions";
      actions: RuntimeInteractionAction[];
    })
  | (RuntimeInteractionRequestBase & {
      kind: "text-input";
      fieldId: string;
      placeholder?: string;
      initialValue?: string;
      multiline?: boolean;
    });

export interface RuntimeInteractionResult {
  interactionId: string;
  status: "submitted" | "cancelled" | "expired";
  values: Record<string, string[]>;
  submittedAt: string;
}

export interface AgentInteractionResumeRequest {
  sessionId: string;
  /** Stable across retries; Adapters must use it to suppress duplicate effects. */
  idempotencyKey: string;
  result: RuntimeInteractionResult;
}

export interface PendingRuntimeInteraction {
  interactionId: string;
  accountId: string;
  conversationId: string;
  conversationType: ConversationType;
  senderId: string;
  adapterId: string;
  sessionId: string;
  request: RuntimeInteractionRequest;
  createdAt: string;
  expiresAt: string;
}

export interface RuntimeInteractionResumeEntry {
  id: string;
  interactionId: string;
  kind: RuntimeInteractionRequest["kind"];
  accountId: string;
  conversationId: string;
  conversationType: ConversationType;
  adapterId: string;
  sessionId: string;
  result: RuntimeInteractionResult;
  attempts: number;
}

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };

export type RuntimeToolEffect = "read-only" | "write" | "destructive";
export type RuntimeToolApproval = "never" | "required";

export interface RuntimeApprovalRequest {
  toolName: string;
  effect: Exclude<RuntimeToolEffect, "read-only">;
  /** Bounded concrete action summary. Never include raw JSON or internal identifiers. */
  summary: string;
  /** Optional Kernel deadline; Gateway applies the shorter of this and its policy timeout. */
  maxWaitMs?: number;
}

export type RuntimeApprovalDecision =
  "approved" | "denied" | "expired" | "interrupted";

export type ApprovalStatus =
  "pending" | "approved" | "denied" | "expired" | "interrupted";

export interface PendingApproval {
  approvalId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  adapterId: string;
  toolName: string;
  effect: Exclude<RuntimeToolEffect, "read-only">;
  summary: string;
  createdAt: string;
  expiresAt: string;
}

export type PresentationInteractionKind = "approval";

export interface PendingPresentationInteraction {
  interactionId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  kind: PresentationInteractionKind;
  correlationId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ResolvedPresentationInteraction {
  interactionId: string;
  kind: PresentationInteractionKind;
  correlationId: string;
  actionId: string;
}

export type RuntimeToolContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "audio"; url: string };

export interface RuntimeToolResult {
  success: boolean;
  content: RuntimeToolContent[];
}

export interface RuntimeToolCallContext {
  /** Opaque Kernel session identifier. Never expose it in user-facing output. */
  sessionId: string;
  /** Opaque Kernel tool-call identifier. Never expose it in user-facing output. */
  callId: string;
}

/**
 * Kernel-neutral client tool. Adapters translate this definition to their native
 * protocol; the Channel never interprets the tool name, arguments, or result.
 */
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: RuntimeJsonValue;
  effect: RuntimeToolEffect;
  approval: RuntimeToolApproval;
  /** Build a bounded, identifier-free description of the concrete side effect. */
  approvalSummary?(input: RuntimeJsonValue): string;
  execute(
    input: RuntimeJsonValue,
    context: RuntimeToolCallContext,
  ): Promise<RuntimeToolResult>;
}

export type AgentRunEvent =
  | { type: "session-started"; sessionId: string }
  | {
      type: "status";
      phase: AgentStatusPhase;
      text?: string;
      emoji?: string;
    }
  | { type: "text-delta"; text: string }
  | { type: "media-output"; media: AgentMediaOutput }
  | { type: "interaction-requested"; request: RuntimeInteractionRequest }
  | { type: "message-completed"; text?: string }
  | { type: "approval-requested"; approvalId: string; summary: string }
  | { type: "failed"; message: string };

export interface AgentRuntimeAdapter {
  readonly id: string;
  readonly contractVersion: RuntimeContractVersion;
  /** Stable storage scope for opaque sessions; change when persisted Kernel state becomes incompatible. */
  readonly sessionCompatibilityId?: string;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  /** Exact non-text inputs accepted by the selected Kernel/model. */
  readonly inputModalities?: ReadonlySet<MediaType>;
  /** Exact media outputs the Adapter may emit. */
  readonly outputModalities?: ReadonlySet<MediaType>;
  /** Prepare process/connection state without creating a semantic Agent turn. */
  start?(): Promise<void>;
  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent>;
  /** Resume a suspended semantic interaction without fabricating a user message. */
  resumeInteraction?(
    request: AgentInteractionResumeRequest,
  ): AsyncIterable<AgentRunEvent>;
  cancel?(sessionId: string): Promise<void>;
  respondToApproval?(approvalId: string, approved: boolean): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  /** Release process/connection state after ingress has stopped and runs drain. */
  stop?(): Promise<void>;
}

/** Runtime guard for JavaScript adapters that can bypass TypeScript checks. */
export function assertRuntimeAdapterCompatible(
  adapter: Pick<AgentRuntimeAdapter, "id" | "contractVersion">,
): void {
  if (
    typeof adapter.id !== "string" ||
    adapter.id.length > 128 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(adapter.id)
  ) {
    throw new Error("Adapter id must use a stable non-empty identifier");
  }
  if (adapter.contractVersion !== RUNTIME_CONTRACT_VERSION) {
    throw new Error(
      `Adapter ${adapter.id} does not support runtime contract v${RUNTIME_CONTRACT_VERSION}`,
    );
  }
}

export interface RuntimeRouter {
  resolve(message: InboundMessage): Promise<{ adapterId: string }>;
}

export interface InboundPolicy {
  authorize(
    message: InboundMessage,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface GatewayStore {
  acceptInbound(message: InboundMessage): Promise<boolean>;
  getSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
  }): Promise<string | undefined>;
  setSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
    sessionId: string;
  }): Promise<void>;
  recordDelivery(record: {
    messageId: string;
    command: OutboundCommand;
    receipt?: DeliveryReceipt;
    error?: string;
  }): Promise<void>;
  enqueueDelivery(record: {
    messageId: string;
    command: DurableOutboundCommand;
    supersedeKey?: string;
    now: string;
  }): Promise<string>;
  claimDelivery(options: {
    deliveryId: string;
    owner: string;
    now: string;
    leaseUntil: string;
  }): Promise<DeliveryOutboxEntry | undefined>;
  claimDueDeliveries(options: {
    owner: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): Promise<DeliveryOutboxEntry[]>;
  completeDelivery(record: {
    deliveryId: string;
    owner: string;
    receipt: DeliveryReceipt;
    now: string;
  }): Promise<void>;
  retryDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    nextAttemptAt: string;
    now: string;
  }): Promise<void>;
  deadLetterDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    now: string;
  }): Promise<void>;
  listReferencedMediaArtifactIds(): Promise<string[]>;
  getDeliveryOutboxStats(): Promise<DeliveryOutboxStats>;
  requeueDeadTextDeliveries(options: {
    limit: number;
    now: string;
  }): Promise<number>;
  createApproval(approval: PendingApproval): Promise<boolean>;
  resolveApproval(options: {
    approvalId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    decision: Exclude<ApprovalStatus, "pending">;
    now: string;
  }): Promise<boolean>;
  interruptPendingApprovals(now: string): Promise<number>;
  createPresentationInteraction(
    interaction: PendingPresentationInteraction,
  ): Promise<boolean>;
  resolvePresentationInteraction(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    actionId: string;
    now: string;
  }): Promise<ResolvedPresentationInteraction | undefined>;
  createRuntimeInteraction(
    interaction: PendingRuntimeInteraction,
  ): Promise<boolean>;
  getPendingRuntimeInteraction(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    now: string;
  }): Promise<PendingRuntimeInteraction | undefined>;
  getPendingRuntimeTextInteraction(options: {
    accountId: string;
    conversationId: string;
    senderId: string;
    now: string;
  }): Promise<PendingRuntimeInteraction | undefined>;
  resolveRuntimeInteractionAndEnqueue(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    result: RuntimeInteractionResult;
    now: string;
  }): Promise<string | undefined>;
  cancelRuntimeInteraction(options: {
    interactionId: string;
    now: string;
  }): Promise<boolean>;
  expireRuntimeInteractionsAndEnqueue(options: {
    now: string;
    limit: number;
  }): Promise<number>;
  claimDueInteractionResumes(options: {
    owner: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): Promise<RuntimeInteractionResumeEntry[]>;
  completeInteractionResume(options: {
    resumeId: string;
    owner: string;
    now: string;
  }): Promise<void>;
  retryInteractionResume(options: {
    resumeId: string;
    owner: string;
    error: string;
    nextAttemptAt: string;
    now: string;
  }): Promise<void>;
  deadLetterInteractionResume(options: {
    resumeId: string;
    owner: string;
    error: string;
    now: string;
  }): Promise<void>;
}

export interface DeliveryOutboxEntry {
  id: string;
  messageId: string;
  command: DurableOutboundCommand;
  attempts: number;
}

export type DeliveryOutboxStatus =
  "pending" | "leased" | "delivered" | "dead" | "superseded";

export type DeliveryOutboxStats = Record<DeliveryOutboxStatus, number>;
