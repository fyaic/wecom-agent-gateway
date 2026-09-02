import {
  CHANNEL_TRANSPORT_CONTRACT_VERSION,
  assertChannelTransportCompatible,
  type ChannelEnterChatEvent,
  type ChannelFeedbackEvent,
  type ChannelTransport,
  type InboundMessage,
  type MediaType,
  type OutboundCommand,
  type Presentation,
} from "@fyaic/wecom-runtime-contract";

export const TRANSPORT_CONFORMANCE_SCHEMA_VERSION = 1 as const;

export type TransportConformanceStatus = "passed" | "failed" | "skipped";

export interface TransportConformanceCheck {
  id: string;
  status: TransportConformanceStatus;
  /** Stable diagnostic code; never an upstream body or command content. */
  code?: string;
}

export interface TransportConformanceReport {
  schemaVersion: typeof TRANSPORT_CONFORMANCE_SCHEMA_VERSION;
  contractVersion: typeof CHANNEL_TRANSPORT_CONTRACT_VERSION;
  transport: {
    id: string;
    capabilities: string[];
    inputModalities: MediaType[];
    outputModalities: MediaType[];
  };
  passed: boolean;
  summary: Record<TransportConformanceStatus, number>;
  checks: TransportConformanceCheck[];
}

/** Test-only control surface kept outside the production Transport SPI. */
export interface TransportConformanceDriver {
  readonly deliveries: readonly OutboundCommand[];
  emitMessage(message: InboundMessage): Promise<void>;
  emitFeedback(event: ChannelFeedbackEvent): Promise<void>;
  emitEnterChat(event: ChannelEnterChatEvent): Promise<boolean>;
}

export interface TransportConformanceOptions {
  timeoutMs?: number;
}

const DIRECT_MESSAGE: InboundMessage = {
  id: "transport-conformance-direct",
  accountId: "transport-account",
  conversationId: "transport-direct-conversation",
  conversationType: "direct",
  senderId: "transport-sender",
  receivedAt: "2000-01-01T00:00:00.000Z",
  parts: [{ type: "text", text: "direct transport text" }],
};

const GROUP_MESSAGE: InboundMessage = {
  ...DIRECT_MESSAGE,
  id: "transport-conformance-group",
  conversationId: "transport-group-conversation",
  conversationType: "group",
  quote: undefined,
  parts: [{ type: "text", text: "group transport text" }],
};

const QUOTED_MESSAGE: InboundMessage = {
  ...DIRECT_MESSAGE,
  id: "transport-conformance-quoted",
  quote: { parts: [{ type: "text", text: "quoted transport text" }] },
  parts: [{ type: "text", text: "current transport text" }],
};

export async function runTransportConformance(
  transport: ChannelTransport,
  driver: TransportConformanceDriver,
  options: TransportConformanceOptions = {},
): Promise<TransportConformanceReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: TransportConformanceCheck[] = [];
  const receivedMessages: InboundMessage[] = [];
  const feedbackEvents: ChannelFeedbackEvent[] = [];
  const enterChatEvents: ChannelEnterChatEvent[] = [];
  let started = false;

  const compatible = await check(
    checks,
    "transport.compatibility",
    async () => {
      assertCapabilityConsistency(transport);
      try {
        assertChannelTransportCompatible(transport);
      } catch {
        throw new ConformanceFailure("incompatible-transport");
      }
    },
  );
  if (!compatible) return report(transport, checks);

  started = await check(checks, "lifecycle.start", () =>
    withTimeout(
      transport.start(
        async (message) => {
          receivedMessages.push(message);
        },
        async (event) => {
          feedbackEvents.push(event);
        },
        async (event) => {
          enterChatEvents.push(event);
          return true;
        },
      ),
      timeoutMs,
    ),
  );

  if (!started) return report(transport, checks);

  await check(checks, "transport.health", async () => {
    const health = await withTimeout(transport.health(), timeoutMs);
    if (!health.ok) throw new ConformanceFailure("unhealthy-transport");
  });

  await check(checks, "inbound.direct", async () => {
    await withTimeout(driver.emitMessage(DIRECT_MESSAGE), timeoutMs);
    if (!same(receivedMessages.at(-1), DIRECT_MESSAGE)) {
      throw new ConformanceFailure("inbound-message-drift");
    }
  });
  await check(checks, "inbound.group", async () => {
    await withTimeout(driver.emitMessage(GROUP_MESSAGE), timeoutMs);
    if (!same(receivedMessages.at(-1), GROUP_MESSAGE)) {
      throw new ConformanceFailure("inbound-message-drift");
    }
  });
  await check(checks, "inbound.quoted", async () => {
    await withTimeout(driver.emitMessage(QUOTED_MESSAGE), timeoutMs);
    if (!same(receivedMessages.at(-1), QUOTED_MESSAGE)) {
      throw new ConformanceFailure("inbound-quote-drift");
    }
  });

  await exerciseFeedback(transport, driver, checks, feedbackEvents, timeoutMs);
  await exerciseEnterChat(
    transport,
    driver,
    checks,
    enterChatEvents,
    timeoutMs,
  );
  await exerciseInputModalities(transport, checks, timeoutMs);
  await exerciseDeliveries(transport, driver, checks, timeoutMs);

  await check(checks, "lifecycle.stop", () =>
    withTimeout(transport.stop(), timeoutMs),
  );
  return report(transport, checks);
}

async function exerciseFeedback(
  transport: ChannelTransport,
  driver: TransportConformanceDriver,
  checks: TransportConformanceCheck[],
  received: ChannelFeedbackEvent[],
  timeoutMs: number,
): Promise<void> {
  if (!transport.capabilities.has("reply-feedback")) {
    checks.push(skipped("event.feedback", "capability-not-declared"));
    return;
  }
  const event: ChannelFeedbackEvent = {
    id: "transport-feedback",
    accountId: DIRECT_MESSAGE.accountId,
    conversationId: DIRECT_MESSAGE.conversationId,
    conversationType: "direct",
    senderId: DIRECT_MESSAGE.senderId,
    receivedAt: DIRECT_MESSAGE.receivedAt,
    feedbackId: "transport-feedback-reference",
  };
  await check(checks, "event.feedback", async () => {
    await withTimeout(driver.emitFeedback(event), timeoutMs);
    if (!same(received.at(-1), event)) {
      throw new ConformanceFailure("feedback-event-drift");
    }
  });
}

async function exerciseEnterChat(
  transport: ChannelTransport,
  driver: TransportConformanceDriver,
  checks: TransportConformanceCheck[],
  received: ChannelEnterChatEvent[],
  timeoutMs: number,
): Promise<void> {
  if (!transport.capabilities.has("static-welcome")) {
    checks.push(skipped("event.enter-chat", "capability-not-declared"));
    return;
  }
  const event: ChannelEnterChatEvent = {
    id: "transport-enter-chat",
    accountId: DIRECT_MESSAGE.accountId,
    conversationId: DIRECT_MESSAGE.conversationId,
    conversationType: "direct",
    senderId: DIRECT_MESSAGE.senderId,
    receivedAt: DIRECT_MESSAGE.receivedAt,
  };
  await check(checks, "event.enter-chat", async () => {
    const replied = await withTimeout(driver.emitEnterChat(event), timeoutMs);
    if (!replied || !same(received.at(-1), event)) {
      throw new ConformanceFailure("enter-chat-event-drift");
    }
  });
}

async function exerciseInputModalities(
  transport: ChannelTransport,
  checks: TransportConformanceCheck[],
  timeoutMs: number,
): Promise<void> {
  for (const modality of transport.inputModalities ?? []) {
    await check(checks, `input.${modality}`, async () => {
      if (!transport.materializeInbound) {
        throw new ConformanceFailure("materializer-not-declared");
      }
      const message: InboundMessage = {
        ...DIRECT_MESSAGE,
        id: `transport-input-${modality}`,
        quote: undefined,
        parts: [
          {
            type: modality,
            url: `https://example.invalid/${modality}`,
            name: `fixture.${modality}`,
          },
        ],
      };
      const materialized = await withTimeout(
        transport.materializeInbound(message),
        timeoutMs,
      );
      if (materialized.message.parts[0]?.type !== modality) {
        throw new ConformanceFailure("materialized-modality-drift");
      }
      await withTimeout(materialized.release(), timeoutMs);
      await withTimeout(materialized.release(), timeoutMs);
    });
  }
}

async function exerciseDeliveries(
  transport: ChannelTransport,
  driver: TransportConformanceDriver,
  checks: TransportConformanceCheck[],
  timeoutMs: number,
): Promise<void> {
  await exerciseDelivery(
    transport,
    driver,
    checks,
    "delivery.reply",
    {
      type: "reply",
      accountId: DIRECT_MESSAGE.accountId,
      conversationId: DIRECT_MESSAGE.conversationId,
      replyReference: { requestId: "transport-request" },
      streamId: "transport-stream",
      text: "transport reply",
      final: true,
    },
    timeoutMs,
  );

  if (transport.capabilities.has("reply-with-presentation")) {
    await exerciseDelivery(
      transport,
      driver,
      checks,
      "delivery.reply-presentation",
      {
        type: "reply",
        accountId: DIRECT_MESSAGE.accountId,
        conversationId: DIRECT_MESSAGE.conversationId,
        replyReference: { requestId: "transport-presentation-request" },
        streamId: "transport-presentation-stream",
        text: "transport reply with presentation",
        final: false,
        presentation: notice("transport-reply-presentation"),
      },
      timeoutMs,
    );
  } else {
    checks.push(
      skipped("delivery.reply-presentation", "capability-not-declared"),
    );
  }

  if (transport.capabilities.has("proactive-message")) {
    await exerciseDelivery(
      transport,
      driver,
      checks,
      "delivery.proactive",
      {
        type: "proactive",
        accountId: DIRECT_MESSAGE.accountId,
        conversationId: DIRECT_MESSAGE.conversationId,
        text: "transport proactive",
      },
      timeoutMs,
    );
  } else {
    checks.push(skipped("delivery.proactive", "capability-not-declared"));
  }

  if (
    transport.capabilities.has("proactive-message") &&
    transport.capabilities.has("structured-presentation")
  ) {
    await exerciseDelivery(
      transport,
      driver,
      checks,
      "delivery.presentation",
      {
        type: "proactive-presentation",
        accountId: DIRECT_MESSAGE.accountId,
        conversationId: DIRECT_MESSAGE.conversationId,
        presentation: notice("transport-proactive-presentation"),
      },
      timeoutMs,
    );
  } else {
    checks.push(skipped("delivery.presentation", "capability-not-declared"));
  }

  if (transport.capabilities.has("interactive-presentation")) {
    await exerciseDelivery(
      transport,
      driver,
      checks,
      "delivery.interaction-update",
      {
        type: "interaction-update",
        accountId: DIRECT_MESSAGE.accountId,
        conversationId: DIRECT_MESSAGE.conversationId,
        replyReference: { requestId: "transport-interaction-request" },
        presentation: notice("transport-interaction-update"),
      },
      timeoutMs,
    );
  } else {
    checks.push(
      skipped("delivery.interaction-update", "capability-not-declared"),
    );
  }

  for (const modality of transport.outputModalities ?? []) {
    await exerciseDelivery(
      transport,
      driver,
      checks,
      `output.${modality}`,
      {
        type: "proactive-media",
        accountId: DIRECT_MESSAGE.accountId,
        conversationId: DIRECT_MESSAGE.conversationId,
        media: {
          type: modality,
          path: `/transport-conformance/${modality}`,
          name: `fixture.${modality}`,
        },
      },
      timeoutMs,
    );
  }
}

async function exerciseDelivery(
  transport: ChannelTransport,
  driver: TransportConformanceDriver,
  checks: TransportConformanceCheck[],
  id: string,
  command: OutboundCommand,
  timeoutMs: number,
): Promise<void> {
  await check(checks, id, async () => {
    const before = driver.deliveries.length;
    const receipt = await withTimeout(transport.deliver(command), timeoutMs);
    if (
      driver.deliveries.length !== before + 1 ||
      !same(driver.deliveries.at(-1), command)
    ) {
      throw new ConformanceFailure("outbound-command-drift");
    }
    if (
      !receipt.id ||
      receipt.id.length > 256 ||
      !Number.isFinite(Date.parse(receipt.acceptedAt))
    ) {
      throw new ConformanceFailure("invalid-acceptance-receipt");
    }
  });
}

function assertCapabilityConsistency(transport: ChannelTransport): void {
  const capabilities = transport.capabilities;
  const input = transport.inputModalities ?? new Set<MediaType>();
  const output = transport.outputModalities ?? new Set<MediaType>();
  if (
    capabilities.has("multimodal-input") !== input.size > 0 ||
    (input.size > 0 &&
      (!capabilities.has("media-download") || !transport.materializeInbound))
  ) {
    throw new ConformanceFailure("inconsistent-input-capabilities");
  }
  if (
    capabilities.has("multimodal-output") !== output.size > 0 ||
    (output.size > 0 && !capabilities.has("media-upload"))
  ) {
    throw new ConformanceFailure("inconsistent-output-capabilities");
  }
  if (
    capabilities.has("interactive-presentation") &&
    !capabilities.has("structured-presentation")
  ) {
    throw new ConformanceFailure("interactive-without-structured");
  }
  if (
    capabilities.has("reply-with-presentation") &&
    (!capabilities.has("structured-presentation") ||
      !capabilities.has("stream-reply-update"))
  ) {
    throw new ConformanceFailure("reply-presentation-prerequisite-missing");
  }
}

async function check(
  checks: TransportConformanceCheck[],
  id: string,
  action: () => Promise<void>,
): Promise<boolean> {
  try {
    await action();
    checks.push({ id, status: "passed" });
    return true;
  } catch (error) {
    checks.push({
      id,
      status: "failed",
      code:
        error instanceof ConformanceFailure
          ? error.code
          : "unexpected-conformance-error",
    });
    return false;
  }
}

function skipped(id: string, code: string): TransportConformanceCheck {
  return { id, status: "skipped", code };
}

function report(
  transport: ChannelTransport,
  checks: TransportConformanceCheck[],
): TransportConformanceReport {
  const summary = { passed: 0, failed: 0, skipped: 0 };
  for (const item of checks) summary[item.status] += 1;
  return {
    schemaVersion: TRANSPORT_CONFORMANCE_SCHEMA_VERSION,
    contractVersion: CHANNEL_TRANSPORT_CONTRACT_VERSION,
    transport: {
      id: transport.id,
      capabilities: [...transport.capabilities].sort(),
      inputModalities: [...(transport.inputModalities ?? [])].sort(),
      outputModalities: [...(transport.outputModalities ?? [])].sort(),
    },
    passed: summary.failed === 0,
    summary,
    checks,
  };
}

function notice(id: string): Presentation {
  return { kind: "notice", id, title: "Transport conformance notice" };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function withTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ConformanceFailure("operation-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ConformanceFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
