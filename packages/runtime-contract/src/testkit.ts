import {
  assertRuntimeAdapterCompatible,
  type AgentRunEvent,
  type AgentRuntimeAdapter,
  type InboundMessage,
} from "./index.js";

export interface RuntimeContractTranscript {
  sessionId: string;
  first: AgentRunEvent[];
  resumed: AgentRunEvent[];
}

export interface ReplyActionContractTranscript {
  resumed: AgentRunEvent[];
  duplicate: AgentRunEvent[];
}

/**
 * Runs the minimum text/session contract shared by every real Kernel adapter.
 * It deliberately contains no vendor assumptions and throws on contract drift.
 */
export async function exerciseTextRuntimeContract(
  adapter: AgentRuntimeAdapter,
  message: InboundMessage,
): Promise<RuntimeContractTranscript> {
  assertRuntimeAdapterCompatible(adapter);
  const health = await adapter.health();
  if (!health.ok)
    throw new Error(`Adapter is unhealthy: ${health.detail ?? "unknown"}`);

  const first = await collect(adapter.run({ message }));
  const sessions = first.filter(
    (event): event is Extract<AgentRunEvent, { type: "session-started" }> =>
      event.type === "session-started",
  );
  if (sessions.length !== 1) {
    throw new Error(
      `First run must start exactly one session; received ${sessions.length}`,
    );
  }
  assertCompleteTextTurn(first, "first");

  const resumed = await collect(
    adapter.run({
      message: { ...message, id: `${message.id}-resume` },
      sessionId: sessions[0].sessionId,
    }),
  );
  const unexpectedSession = resumed.find(
    (event) =>
      event.type === "session-started" &&
      event.sessionId !== sessions[0].sessionId,
  );
  if (unexpectedSession) {
    throw new Error("Resumed run created a different session");
  }
  assertCompleteTextTurn(resumed, "resumed");

  return { sessionId: sessions[0].sessionId, first, resumed };
}

/**
 * Verifies the adapter-neutral final-reply action contract. The callback is a
 * real new turn in the existing Kernel session and duplicate delivery is inert.
 */
export async function exerciseReplyActionRuntimeContract(
  adapter: AgentRuntimeAdapter,
  message: InboundMessage,
  sessionId: string,
): Promise<ReplyActionContractTranscript> {
  if (
    !adapter.capabilities.has("interaction-resume") ||
    !adapter.capabilities.has("reply-actions") ||
    !adapter.resumeInteraction
  ) {
    throw new Error("Adapter does not support reply action continuation");
  }
  const request = {
    sessionId,
    idempotencyKey: `reply-action:${message.id}`,
    interaction: {
      kind: "actions" as const,
      title: "Next",
      actions: [{ value: "continue", label: "Continue" }],
      resumeMode: "new-turn" as const,
    },
    result: {
      interactionId: `interaction:${message.id}`,
      status: "submitted" as const,
      values: { action: ["continue"] },
      submittedAt: message.receivedAt,
    },
    message,
  };
  const resumed = await collect(adapter.resumeInteraction(request));
  assertCompleteTextTurn(resumed, "reply action");
  const duplicate = await collect(adapter.resumeInteraction(request));
  if (duplicate.length !== 0) {
    throw new Error("Duplicate reply action produced a second Kernel turn");
  }
  return { resumed, duplicate };
}

async function collect(
  iterable: AsyncIterable<AgentRunEvent>,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function assertCompleteTextTurn(events: AgentRunEvent[], label: string): void {
  const failures = events.filter((event) => event.type === "failed");
  if (failures.length > 0) throw new Error(`${label} run failed`);

  const completed = events.filter(
    (event): event is Extract<AgentRunEvent, { type: "message-completed" }> =>
      event.type === "message-completed",
  );
  if (completed.length !== 1) {
    throw new Error(
      `${label} run must complete exactly once; received ${completed.length}`,
    );
  }

  const streamed = events
    .filter(
      (event): event is Extract<AgentRunEvent, { type: "text-delta" }> =>
        event.type === "text-delta",
    )
    .map((event) => event.text)
    .join("");
  if (!streamed) throw new Error(`${label} run produced no streamed text`);
  if (completed[0].text !== streamed) {
    throw new Error(`${label} final text does not equal the streamed text`);
  }
}
