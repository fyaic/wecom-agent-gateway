import type {
  ApprovalStatus,
  DeliveryOutboxEntry,
  DeliveryOutboxStats,
  DeliveryOutboxStatus,
  DeliveryReceipt,
  DurableOutboundCommand,
  GatewayStore,
  InboundMessage,
  OutboundCommand,
  PendingApproval,
  PendingPresentationInteraction,
  PendingRuntimeInteraction,
  ResolvedPresentationInteraction,
  RuntimeInteractionResumeEntry,
  RuntimeInteractionResult,
} from "@fyaic/wecom-runtime-contract";

interface MemoryOutboxItem {
  id: string;
  messageId: string;
  command: DurableOutboundCommand;
  supersedeKey?: string;
  status: DeliveryOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
}

interface MemoryApproval extends PendingApproval {
  status: ApprovalStatus;
  resolvedAt?: string;
}

interface MemoryPresentationInteraction extends PendingPresentationInteraction {
  status: "pending" | "resolved" | "expired";
  actionId?: string;
  resolvedAt?: string;
}

interface MemoryRuntimeInteraction extends PendingRuntimeInteraction {
  status: "pending" | "answered" | "expired" | "cancelled";
  result?: RuntimeInteractionResult;
  resolvedAt?: string;
}

interface MemoryInteractionResume {
  id: string;
  interactionId: string;
  kind: PendingRuntimeInteraction["request"]["kind"];
  accountId: string;
  conversationId: string;
  conversationType: RuntimeInteractionResumeEntry["conversationType"];
  adapterId: string;
  sessionId: string;
  senderId: string;
  request: PendingRuntimeInteraction["request"];
  result: RuntimeInteractionResult;
  status: "pending" | "leased" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: string;
}

export class MemoryGatewayStore implements GatewayStore {
  readonly deliveries: Array<{
    messageId: string;
    command: OutboundCommand | DurableOutboundCommand;
    receipt?: DeliveryReceipt;
    error?: string;
  }> = [];
  private readonly inboundIds = new Set<string>();
  private readonly sessions = new Map<string, string>();
  private readonly outbox = new Map<string, MemoryOutboxItem>();
  private readonly approvals = new Map<string, MemoryApproval>();
  private readonly presentationInteractions = new Map<
    string,
    MemoryPresentationInteraction
  >();
  private readonly runtimeInteractions = new Map<
    string,
    MemoryRuntimeInteraction
  >();
  private readonly interactionResumes = new Map<
    string,
    MemoryInteractionResume
  >();
  private nextOutboxId = 1;
  private nextInteractionResumeId = 1;

  async acceptInbound(message: InboundMessage): Promise<boolean> {
    const key = `${message.accountId}:${message.id}`;
    if (this.inboundIds.has(key)) return false;
    this.inboundIds.add(key);
    return true;
  }

  async getSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
  }): Promise<string | undefined> {
    return this.sessions.get(this.sessionKey(scope));
  }

  async setSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
    sessionId: string;
  }): Promise<void> {
    this.sessions.set(this.sessionKey(scope), scope.sessionId);
  }

  async recordDelivery(record: {
    messageId: string;
    command: OutboundCommand;
    receipt?: DeliveryReceipt;
    error?: string;
  }): Promise<void> {
    this.deliveries.push(record);
  }

  async enqueueDelivery(record: {
    messageId: string;
    command: DurableOutboundCommand;
    supersedeKey?: string;
    now: string;
  }): Promise<string> {
    if (record.supersedeKey) {
      for (const item of this.outbox.values()) {
        if (
          item.supersedeKey === record.supersedeKey &&
          item.status === "pending"
        ) {
          item.status = "superseded";
        }
      }
    }
    const id = String(this.nextOutboxId++);
    this.outbox.set(id, {
      id,
      messageId: record.messageId,
      command: record.command,
      supersedeKey: record.supersedeKey,
      status: "pending",
      attempts: 0,
      nextAttemptAt: record.now,
    });
    return id;
  }

  async claimDelivery(options: {
    deliveryId: string;
    owner: string;
    now: string;
    leaseUntil: string;
  }): Promise<DeliveryOutboxEntry | undefined> {
    const item = this.outbox.get(options.deliveryId);
    return item && claimable(item, options.now)
      ? lease(item, options.owner, options.leaseUntil)
      : undefined;
  }

  async claimDueDeliveries(options: {
    owner: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): Promise<DeliveryOutboxEntry[]> {
    return [...this.outbox.values()]
      .filter((item) => claimable(item, options.now))
      .sort((left, right) => Number(left.id) - Number(right.id))
      .slice(0, options.limit)
      .map((item) => lease(item, options.owner, options.leaseUntil));
  }

  async completeDelivery(record: {
    deliveryId: string;
    owner: string;
    receipt: DeliveryReceipt;
    now: string;
  }): Promise<void> {
    const item = this.leased(record.deliveryId, record.owner);
    item.status = "delivered";
    this.deliveries.push({
      messageId: item.messageId,
      command: item.command,
      receipt: record.receipt,
    });
  }

  async retryDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    nextAttemptAt: string;
    now: string;
  }): Promise<void> {
    const item = this.leased(record.deliveryId, record.owner);
    item.status = "pending";
    item.nextAttemptAt = record.nextAttemptAt;
    item.leaseOwner = undefined;
    item.leaseUntil = undefined;
  }

  async deadLetterDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    now: string;
  }): Promise<void> {
    const item = this.leased(record.deliveryId, record.owner);
    item.status = "dead";
    this.deliveries.push({
      messageId: item.messageId,
      command: item.command,
      error: record.error,
    });
  }

  async listReferencedMediaArtifactIds(): Promise<string[]> {
    return [...this.outbox.values()]
      .filter(
        (item) =>
          (item.status === "pending" || item.status === "leased") &&
          item.command.type === "proactive-media",
      )
      .map((item) =>
        item.command.type === "proactive-media"
          ? item.command.media.artifactId
          : "",
      );
  }

  async getDeliveryOutboxStats(): Promise<DeliveryOutboxStats> {
    const stats = emptyOutboxStats();
    for (const item of this.outbox.values()) stats[item.status] += 1;
    return stats;
  }

  async requeueDeadTextDeliveries(options: {
    limit: number;
    now: string;
  }): Promise<number> {
    let requeued = 0;
    for (const item of this.outbox.values()) {
      if (requeued >= Math.max(0, options.limit)) break;
      if (item.status !== "dead" || !isReplayableText(item.command)) continue;
      item.status = "pending";
      item.attempts = 0;
      item.nextAttemptAt = options.now;
      item.leaseOwner = undefined;
      item.leaseUntil = undefined;
      requeued += 1;
    }
    return requeued;
  }

  async createApproval(approval: PendingApproval): Promise<boolean> {
    if (this.approvals.has(approval.approvalId)) return false;
    this.approvals.set(approval.approvalId, {
      ...approval,
      status: "pending",
    });
    return true;
  }

  async resolveApproval(options: {
    approvalId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    decision: Exclude<ApprovalStatus, "pending">;
    now: string;
  }): Promise<boolean> {
    const approval = this.approvals.get(options.approvalId);
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.accountId !== options.accountId ||
      approval.conversationId !== options.conversationId ||
      approval.senderId !== options.senderId ||
      (options.decision !== "expired" && approval.expiresAt <= options.now)
    ) {
      return false;
    }
    approval.status = options.decision;
    approval.resolvedAt = options.now;
    return true;
  }

  async interruptPendingApprovals(now: string): Promise<number> {
    let interrupted = 0;
    for (const approval of this.approvals.values()) {
      if (approval.status !== "pending") continue;
      approval.status = "interrupted";
      approval.resolvedAt = now;
      interrupted += 1;
    }
    return interrupted;
  }

  async createPresentationInteraction(
    interaction: PendingPresentationInteraction,
  ): Promise<boolean> {
    if (this.presentationInteractions.has(interaction.interactionId)) {
      return false;
    }
    this.presentationInteractions.set(interaction.interactionId, {
      ...interaction,
      status: "pending",
    });
    return true;
  }

  async resolvePresentationInteraction(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    actionId: string;
    now: string;
  }): Promise<ResolvedPresentationInteraction | undefined> {
    const interaction = this.presentationInteractions.get(
      options.interactionId,
    );
    if (
      interaction?.status === "pending" &&
      interaction.expiresAt <= options.now
    ) {
      interaction.status = "expired";
      interaction.resolvedAt = options.now;
    }
    if (
      !interaction ||
      interaction.status !== "pending" ||
      interaction.accountId !== options.accountId ||
      interaction.conversationId !== options.conversationId ||
      interaction.senderId !== options.senderId ||
      interaction.expiresAt <= options.now
    ) {
      return undefined;
    }
    interaction.status = "resolved";
    interaction.actionId = options.actionId;
    interaction.resolvedAt = options.now;
    return {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      correlationId: interaction.correlationId,
      actionId: options.actionId,
    };
  }

  async createRuntimeInteraction(
    interaction: PendingRuntimeInteraction,
  ): Promise<boolean> {
    if (this.runtimeInteractions.has(interaction.interactionId)) return false;
    for (const candidate of this.runtimeInteractions.values()) {
      if (
        candidate.status !== "pending" ||
        candidate.accountId !== interaction.accountId ||
        candidate.conversationId !== interaction.conversationId ||
        candidate.expiresAt <= interaction.createdAt
      ) {
        continue;
      }
      if (isReplyActionRequest(candidate.request)) {
        candidate.status = "cancelled";
        candidate.resolvedAt = interaction.createdAt;
        continue;
      }
      return false;
    }
    this.runtimeInteractions.set(interaction.interactionId, {
      ...interaction,
      status: "pending",
    });
    return true;
  }

  async getPendingRuntimeInteraction(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    now: string;
  }): Promise<PendingRuntimeInteraction | undefined> {
    const interaction = this.runtimeInteractions.get(options.interactionId);
    if (
      !interaction ||
      interaction.status !== "pending" ||
      interaction.accountId !== options.accountId ||
      interaction.conversationId !== options.conversationId ||
      interaction.senderId !== options.senderId ||
      interaction.expiresAt <= options.now
    ) {
      return undefined;
    }
    return runtimeInteractionCopy(interaction);
  }

  async getPendingRuntimeTextInteraction(options: {
    accountId: string;
    conversationId: string;
    senderId: string;
    now: string;
  }): Promise<PendingRuntimeInteraction | undefined> {
    const interaction = [...this.runtimeInteractions.values()].find(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.request.kind === "text-input" &&
        candidate.accountId === options.accountId &&
        candidate.conversationId === options.conversationId &&
        candidate.senderId === options.senderId &&
        candidate.expiresAt > options.now,
    );
    return interaction ? runtimeInteractionCopy(interaction) : undefined;
  }

  async resolveRuntimeInteractionAndEnqueue(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    result: RuntimeInteractionResult;
    now: string;
  }): Promise<string | undefined> {
    const interaction = this.runtimeInteractions.get(options.interactionId);
    if (
      !interaction ||
      interaction.status !== "pending" ||
      interaction.accountId !== options.accountId ||
      interaction.conversationId !== options.conversationId ||
      interaction.senderId !== options.senderId ||
      interaction.expiresAt <= options.now
    ) {
      return undefined;
    }
    interaction.status =
      options.result.status === "cancelled" ? "cancelled" : "answered";
    interaction.result = options.result;
    interaction.resolvedAt = options.now;
    const id = String(this.nextInteractionResumeId++);
    this.interactionResumes.set(id, {
      id,
      interactionId: interaction.interactionId,
      kind: interaction.request.kind,
      accountId: interaction.accountId,
      conversationId: interaction.conversationId,
      conversationType: interaction.conversationType,
      adapterId: interaction.adapterId,
      sessionId: interaction.sessionId,
      senderId: interaction.senderId,
      request: interaction.request,
      result: options.result,
      status: "pending",
      attempts: 0,
      nextAttemptAt: options.now,
    });
    return id;
  }

  async cancelRuntimeInteraction(options: {
    interactionId: string;
    now: string;
  }): Promise<boolean> {
    const interaction = this.runtimeInteractions.get(options.interactionId);
    if (!interaction || interaction.status !== "pending") return false;
    interaction.status = "cancelled";
    interaction.resolvedAt = options.now;
    return true;
  }

  async expireRuntimeInteractionsAndEnqueue(options: {
    now: string;
    limit: number;
  }): Promise<number> {
    const expired = [...this.runtimeInteractions.values()]
      .filter(
        (interaction) =>
          interaction.status === "pending" &&
          interaction.expiresAt <= options.now,
      )
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, Math.max(0, options.limit));
    for (const interaction of expired) {
      const result: RuntimeInteractionResult = {
        interactionId: interaction.interactionId,
        status: "expired",
        values: {},
        submittedAt: options.now,
      };
      interaction.status = "expired";
      interaction.result = result;
      interaction.resolvedAt = options.now;
      if (isReplyActionRequest(interaction.request)) continue;
      const id = String(this.nextInteractionResumeId++);
      this.interactionResumes.set(id, {
        id,
        interactionId: interaction.interactionId,
        kind: interaction.request.kind,
        accountId: interaction.accountId,
        conversationId: interaction.conversationId,
        conversationType: interaction.conversationType,
        adapterId: interaction.adapterId,
        sessionId: interaction.sessionId,
        senderId: interaction.senderId,
        request: interaction.request,
        result,
        status: "pending",
        attempts: 0,
        nextAttemptAt: options.now,
      });
    }
    return expired.length;
  }

  async claimDueInteractionResumes(options: {
    owner: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): Promise<RuntimeInteractionResumeEntry[]> {
    return [...this.interactionResumes.values()]
      .filter((item) => interactionResumeClaimable(item, options.now))
      .sort((left, right) => Number(left.id) - Number(right.id))
      .slice(0, options.limit)
      .map((item) =>
        leaseInteractionResume(item, options.owner, options.leaseUntil),
      );
  }

  async completeInteractionResume(options: {
    resumeId: string;
    owner: string;
    now: string;
  }): Promise<void> {
    const item = this.leasedInteractionResume(options.resumeId, options.owner);
    item.status = "delivered";
    item.leaseOwner = undefined;
    item.leaseUntil = undefined;
  }

  async retryInteractionResume(options: {
    resumeId: string;
    owner: string;
    error: string;
    nextAttemptAt: string;
    now: string;
  }): Promise<void> {
    const item = this.leasedInteractionResume(options.resumeId, options.owner);
    item.status = "pending";
    item.nextAttemptAt = options.nextAttemptAt;
    item.lastError = options.error;
    item.leaseOwner = undefined;
    item.leaseUntil = undefined;
  }

  async deadLetterInteractionResume(options: {
    resumeId: string;
    owner: string;
    error: string;
    now: string;
  }): Promise<void> {
    const item = this.leasedInteractionResume(options.resumeId, options.owner);
    item.status = "dead";
    item.lastError = options.error;
    item.leaseOwner = undefined;
    item.leaseUntil = undefined;
  }

  private sessionKey(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
  }): string {
    return `${scope.accountId}:${scope.conversationId}:${scope.adapterId}`;
  }

  private leased(deliveryId: string, owner: string) {
    const item = this.outbox.get(deliveryId);
    if (!item || item.status !== "leased" || item.leaseOwner !== owner) {
      throw new Error(`Outbox delivery is not leased by owner: ${deliveryId}`);
    }
    return item;
  }

  private leasedInteractionResume(resumeId: string, owner: string) {
    const item = this.interactionResumes.get(resumeId);
    if (!item || item.status !== "leased" || item.leaseOwner !== owner) {
      throw new Error(`Interaction resume is not leased by owner: ${resumeId}`);
    }
    return item;
  }
}

function emptyOutboxStats(): DeliveryOutboxStats {
  return {
    pending: 0,
    leased: 0,
    delivered: 0,
    dead: 0,
    superseded: 0,
  };
}

function isReplayableText(command: DurableOutboundCommand): boolean {
  return (
    command.type === "proactive" || (command.type === "reply" && command.final)
  );
}

function claimable(item: MemoryOutboxItem, now: string): boolean {
  return (
    (item.status === "pending" && item.nextAttemptAt <= now) ||
    (item.status === "leased" &&
      Boolean(item.leaseUntil && item.leaseUntil <= now))
  );
}

function lease(
  item: MemoryOutboxItem,
  owner: string,
  leaseUntil: string,
): DeliveryOutboxEntry {
  item.status = "leased";
  item.leaseOwner = owner;
  item.leaseUntil = leaseUntil;
  item.attempts += 1;
  return {
    id: item.id,
    messageId: item.messageId,
    command: item.command,
    attempts: item.attempts,
  };
}

function runtimeInteractionCopy(
  interaction: MemoryRuntimeInteraction,
): PendingRuntimeInteraction {
  const {
    status: _status,
    result: _result,
    resolvedAt: _resolvedAt,
    ...copy
  } = interaction;
  return copy;
}

function interactionResumeClaimable(
  item: MemoryInteractionResume,
  now: string,
): boolean {
  return (
    (item.status === "pending" && item.nextAttemptAt <= now) ||
    (item.status === "leased" &&
      Boolean(item.leaseUntil && item.leaseUntil <= now))
  );
}

function leaseInteractionResume(
  item: MemoryInteractionResume,
  owner: string,
  leaseUntil: string,
): RuntimeInteractionResumeEntry {
  item.status = "leased";
  item.leaseOwner = owner;
  item.leaseUntil = leaseUntil;
  item.attempts += 1;
  return {
    id: item.id,
    interactionId: item.interactionId,
    kind: item.kind,
    accountId: item.accountId,
    conversationId: item.conversationId,
    conversationType: item.conversationType,
    adapterId: item.adapterId,
    sessionId: item.sessionId,
    senderId: item.senderId,
    request: item.request,
    result: item.result,
    attempts: item.attempts,
  };
}

function isReplyActionRequest(
  request: PendingRuntimeInteraction["request"],
): boolean {
  return request.kind === "actions" && request.resumeMode === "new-turn";
}
