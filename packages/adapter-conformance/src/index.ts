import {
  RUNTIME_CONTRACT_VERSION,
  assertRuntimeAdapterCompatible,
  type AgentRunEvent,
  type AgentRuntimeAdapter,
  type InboundMessage,
  type MediaType,
  type MessagePart,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";
import { stat } from "node:fs/promises";

export const ADAPTER_CONFORMANCE_SCHEMA_VERSION = 1 as const;

export type ConformanceCheckStatus = "passed" | "failed" | "skipped";

export interface AdapterConformanceCheck {
  id: string;
  status: ConformanceCheckStatus;
  /** Stable diagnostic code; never an upstream error message. */
  code?: string;
  detail?: string;
}

export interface AdapterConformanceReport {
  schemaVersion: typeof ADAPTER_CONFORMANCE_SCHEMA_VERSION;
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  adapter: {
    id: string;
    sessionCompatibilityId?: string;
    capabilities: RuntimeCapability[];
    inputModalities: MediaType[];
    outputModalities: MediaType[];
  };
  passed: boolean;
  summary: Record<ConformanceCheckStatus, number>;
  checks: AdapterConformanceCheck[];
}

export interface AdapterConformanceOptions {
  timeoutMs?: number;
  /** Protected local fixtures used only for modalities declared by the Adapter. */
  mediaFixtures?: Partial<Record<MediaType, string>>;
  /** Opt in to an active cancellation probe; it may create a real Kernel turn. */
  exerciseCancel?: boolean;
}

interface SuccessfulTurn {
  events: AgentRunEvent[];
  sessionId?: string;
}

const BASE_MESSAGE: InboundMessage = {
  id: "conformance-message",
  accountId: "conformance-account",
  conversationId: "conformance-conversation",
  conversationType: "direct",
  senderId: "conformance-sender",
  receivedAt: "2000-01-01T00:00:00.000Z",
  parts: [{ type: "text", text: "conformance text" }],
};

export async function runAdapterConformance(
  adapter: AgentRuntimeAdapter,
  options: AdapterConformanceOptions = {},
): Promise<AdapterConformanceReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: AdapterConformanceCheck[] = [];
  let started = false;
  let baseTurn: SuccessfulTurn | undefined;

  await check(checks, "adapter.compatibility", async () => {
    assertRuntimeAdapterCompatible(adapter);
    assertCapabilityShape(adapter);
  });

  if (checks.some((item) => item.status === "failed")) {
    return report(adapter, checks);
  }

  if (adapter.start) {
    const result = await check(checks, "lifecycle.start", () =>
      withTimeout(adapter.start!(), timeoutMs),
    );
    started = result;
  } else {
    checks.push(skipped("lifecycle.start", "optional-method-not-declared"));
    started = true;
  }

  if (started) {
    await check(checks, "adapter.health", async () => {
      const health = await withTimeout(adapter.health(), timeoutMs);
      if (!health.ok) throw new ConformanceFailure("unhealthy-adapter");
    });

    const textPassed = await check(checks, "turn.text", async () => {
      baseTurn = validateSuccessfulTurn(
        await collect(adapter.run({ message: BASE_MESSAGE }), timeoutMs),
        adapter,
      );
    });

    if (textPassed && adapter.capabilities.has("resume")) {
      await check(checks, "turn.session-resume", async () => {
        if (!baseTurn?.sessionId) {
          throw new ConformanceFailure("missing-session-id");
        }
        const resumed = validateSuccessfulTurn(
          await collect(
            adapter.run({
              message: { ...BASE_MESSAGE, id: "conformance-resume" },
              sessionId: baseTurn.sessionId,
            }),
            timeoutMs,
          ),
          adapter,
        );
        if (resumed.sessionId && resumed.sessionId !== baseTurn.sessionId) {
          throw new ConformanceFailure("resume-created-different-session");
        }
      });
    } else {
      checks.push(
        skipped(
          "turn.session-resume",
          textPassed ? "capability-not-declared" : "prerequisite-failed",
        ),
      );
    }

    if (textPassed && adapter.capabilities.has("quoted-context")) {
      await check(checks, "turn.quoted-context", async () => {
        validateSuccessfulTurn(
          await collect(
            adapter.run({
              message: {
                ...BASE_MESSAGE,
                id: "conformance-quote",
                quote: {
                  parts: [{ type: "text", text: "quoted conformance text" }],
                },
              },
              ...(baseTurn?.sessionId ? { sessionId: baseTurn.sessionId } : {}),
            }),
            timeoutMs,
          ),
          adapter,
        );
      });
    } else {
      checks.push(
        skipped(
          "turn.quoted-context",
          textPassed ? "capability-not-declared" : "prerequisite-failed",
        ),
      );
    }

    await exerciseMedia(adapter, options, checks, timeoutMs, baseTurn);
    await exerciseReplyActions(adapter, checks, timeoutMs, baseTurn);
    await exerciseCancellation(adapter, options, checks, timeoutMs, baseTurn);
    addUnexercisedCapabilityChecks(adapter, checks);
  } else {
    checks.push(skipped("adapter.health", "prerequisite-failed"));
    checks.push(skipped("turn.text", "prerequisite-failed"));
  }

  if (adapter.stop && started) {
    await check(checks, "lifecycle.stop", () =>
      withTimeout(adapter.stop!(), timeoutMs),
    );
  } else {
    checks.push(
      skipped(
        "lifecycle.stop",
        adapter.stop ? "prerequisite-failed" : "optional-method-not-declared",
      ),
    );
  }

  return report(adapter, checks);
}

async function exerciseMedia(
  adapter: AgentRuntimeAdapter,
  options: AdapterConformanceOptions,
  checks: AdapterConformanceCheck[],
  timeoutMs: number,
  baseTurn?: SuccessfulTurn,
): Promise<void> {
  for (const type of adapter.inputModalities ?? []) {
    const path = options.mediaFixtures?.[type];
    if (!path) {
      checks.push(skipped(`turn.media.${type}`, "fixture-not-provided"));
      continue;
    }
    await check(checks, `turn.media.${type}`, async () => {
      const fixture = await stat(path);
      if (!fixture.isFile()) {
        throw new ConformanceFailure("media-fixture-not-regular-file");
      }
      const part = { type, path } as MessagePart;
      validateSuccessfulTurn(
        await collect(
          adapter.run({
            message: {
              ...BASE_MESSAGE,
              id: `conformance-media-${type}`,
              parts: [part],
            },
            ...(baseTurn?.sessionId ? { sessionId: baseTurn.sessionId } : {}),
          }),
          timeoutMs,
        ),
        adapter,
      );
    });
  }
}

async function exerciseReplyActions(
  adapter: AgentRuntimeAdapter,
  checks: AdapterConformanceCheck[],
  timeoutMs: number,
  baseTurn?: SuccessfulTurn,
): Promise<void> {
  if (!adapter.capabilities.has("reply-actions")) {
    checks.push(
      skipped("interaction.reply-actions", "capability-not-declared"),
    );
    return;
  }
  await check(checks, "interaction.reply-actions", async () => {
    if (!adapter.resumeInteraction || !baseTurn?.sessionId) {
      throw new ConformanceFailure("missing-interaction-prerequisite");
    }
    const request = {
      sessionId: baseTurn.sessionId,
      idempotencyKey: "conformance-reply-action",
      interaction: {
        kind: "actions" as const,
        title: "Next",
        actions: [{ value: "continue", label: "Continue" }],
        resumeMode: "new-turn" as const,
      },
      result: {
        interactionId: "conformance-interaction",
        status: "submitted" as const,
        values: { action: ["continue"] },
        submittedAt: BASE_MESSAGE.receivedAt,
      },
      message: { ...BASE_MESSAGE, id: "conformance-reply-action-message" },
    };
    validateSuccessfulTurn(
      await collect(adapter.resumeInteraction(request), timeoutMs),
      adapter,
    );
    const duplicate = await collect(
      adapter.resumeInteraction(request),
      timeoutMs,
    );
    if (duplicate.length !== 0) {
      throw new ConformanceFailure("duplicate-interaction-produced-events");
    }
  });
}

async function exerciseCancellation(
  adapter: AgentRuntimeAdapter,
  options: AdapterConformanceOptions,
  checks: AdapterConformanceCheck[],
  timeoutMs: number,
  baseTurn?: SuccessfulTurn,
): Promise<void> {
  if (!adapter.capabilities.has("cancel")) {
    checks.push(skipped("turn.cancel", "capability-not-declared"));
    return;
  }
  if (!options.exerciseCancel) {
    checks.push(skipped("turn.cancel", "active-probe-not-enabled"));
    return;
  }
  await check(checks, "turn.cancel", async () => {
    if (!adapter.cancel || !baseTurn?.sessionId) {
      throw new ConformanceFailure("missing-cancel-prerequisite");
    }
    const iterator = adapter
      .run({
        message: { ...BASE_MESSAGE, id: "conformance-cancel" },
        sessionId: baseTurn.sessionId,
      })
      [Symbol.asyncIterator]();
    const first = await withTimeout(iterator.next(), timeoutMs);
    if (first.done)
      throw new ConformanceFailure("cancel-run-ended-before-probe");
    await withTimeout(adapter.cancel(baseTurn.sessionId), timeoutMs);
    await withTimeout(adapter.cancel(baseTurn.sessionId), timeoutMs);
    const remaining = await collectIterator(iterator, timeoutMs);
    const events = [first.value, ...remaining];
    if (events.some((event) => event.type === "message-completed")) {
      throw new ConformanceFailure("cancelled-run-completed-successfully");
    }
    if (events.filter((event) => event.type === "failed").length !== 1) {
      throw new ConformanceFailure("cancelled-run-missing-terminal-failure");
    }
  });
}

function addUnexercisedCapabilityChecks(
  adapter: AgentRuntimeAdapter,
  checks: AdapterConformanceCheck[],
): void {
  for (const capability of [
    "approval",
    "tools",
    "status-events",
    "multimodal-output",
    "interaction-live-resume",
  ] as const) {
    if (adapter.capabilities.has(capability)) {
      checks.push(
        skipped(
          `capability.${capability}`,
          "requires-adapter-specific-deterministic-probe",
        ),
      );
    }
  }
}

function validateSuccessfulTurn(
  events: AgentRunEvent[],
  adapter: AgentRuntimeAdapter,
): SuccessfulTurn {
  const terminalIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) =>
      ["message-completed", "failed"].includes(event.type),
    );
  if (terminalIndexes.length !== 1) {
    throw new ConformanceFailure("turn-must-have-one-terminal");
  }
  const terminal = terminalIndexes[0];
  if (terminal.index !== events.length - 1) {
    throw new ConformanceFailure("events-after-terminal");
  }
  if (terminal.event.type !== "message-completed") {
    throw new ConformanceFailure("turn-failed");
  }
  if (!terminal.event.text) {
    throw new ConformanceFailure("completed-turn-missing-text");
  }

  const deltas = events.filter(
    (event): event is Extract<AgentRunEvent, { type: "text-delta" }> =>
      event.type === "text-delta",
  );
  if (adapter.capabilities.has("streaming")) {
    if (deltas.length === 0) {
      throw new ConformanceFailure("streaming-without-deltas");
    }
    if (deltas.map((event) => event.text).join("") !== terminal.event.text) {
      throw new ConformanceFailure("stream-does-not-match-final");
    }
  } else if (deltas.length > 0) {
    throw new ConformanceFailure("undeclared-streaming-events");
  }

  if (
    events.some((event) => event.type === "status") &&
    !adapter.capabilities.has("status-events")
  ) {
    throw new ConformanceFailure("undeclared-status-events");
  }
  if (
    events.some((event) => event.type === "media-output") &&
    !adapter.capabilities.has("multimodal-output")
  ) {
    throw new ConformanceFailure("undeclared-media-output");
  }
  if (
    events.some((event) => event.type === "approval-requested") &&
    !adapter.capabilities.has("approval")
  ) {
    throw new ConformanceFailure("undeclared-approval-events");
  }

  const sessions = events.filter(
    (event): event is Extract<AgentRunEvent, { type: "session-started" }> =>
      event.type === "session-started",
  );
  if (sessions.length > 1) {
    throw new ConformanceFailure("multiple-session-started-events");
  }
  return { events, sessionId: sessions[0]?.sessionId };
}

function assertCapabilityShape(adapter: AgentRuntimeAdapter): void {
  if (adapter.capabilities.has("cancel") && !adapter.cancel) {
    throw new ConformanceFailure("cancel-method-missing");
  }
  if (
    adapter.capabilities.has("interaction-resume") &&
    !adapter.resumeInteraction
  ) {
    throw new ConformanceFailure("interaction-resume-method-missing");
  }
  if (
    (adapter.capabilities.has("reply-actions") ||
      adapter.capabilities.has("interaction-live-resume")) &&
    !adapter.capabilities.has("interaction-resume")
  ) {
    throw new ConformanceFailure("interaction-capability-dependency-missing");
  }
  if (
    adapter.inputModalities &&
    adapter.inputModalities.size > 0 &&
    !adapter.capabilities.has("multimodal-input")
  ) {
    throw new ConformanceFailure("multimodal-input-capability-missing");
  }
  if (
    adapter.outputModalities &&
    adapter.outputModalities.size > 0 &&
    !adapter.capabilities.has("multimodal-output")
  ) {
    throw new ConformanceFailure("multimodal-output-capability-missing");
  }
}

async function collect(
  iterable: AsyncIterable<AgentRunEvent>,
  timeoutMs: number,
): Promise<AgentRunEvent[]> {
  return collectIterator(iterable[Symbol.asyncIterator](), timeoutMs);
}

async function collectIterator(
  iterator: AsyncIterator<AgentRunEvent>,
  timeoutMs: number,
): Promise<AgentRunEvent[]> {
  return withTimeout(
    (async () => {
      const events: AgentRunEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) return events;
        events.push(next.value);
      }
    })(),
    timeoutMs,
  );
}

async function check(
  checks: AdapterConformanceCheck[],
  id: string,
  operation: () => Promise<void> | void,
): Promise<boolean> {
  try {
    await operation();
    checks.push({ id, status: "passed" });
    return true;
  } catch (error) {
    checks.push({
      id,
      status: "failed",
      code:
        error instanceof ConformanceFailure
          ? error.code
          : "adapter-operation-failed",
    });
    return false;
  }
}

function skipped(id: string, code: string): AdapterConformanceCheck {
  return { id, status: "skipped", code };
}

function report(
  adapter: AgentRuntimeAdapter,
  checks: AdapterConformanceCheck[],
): AdapterConformanceReport {
  const summary = { passed: 0, failed: 0, skipped: 0 };
  for (const item of checks) summary[item.status] += 1;
  return {
    schemaVersion: ADAPTER_CONFORMANCE_SCHEMA_VERSION,
    contractVersion: RUNTIME_CONTRACT_VERSION,
    adapter: {
      id: adapter.id,
      ...(adapter.sessionCompatibilityId
        ? { sessionCompatibilityId: adapter.sessionCompatibilityId }
        : {}),
      capabilities: [...adapter.capabilities].sort(),
      inputModalities: [...(adapter.inputModalities ?? [])].sort(),
      outputModalities: [...(adapter.outputModalities ?? [])].sort(),
    },
    passed: summary.failed === 0,
    summary,
    checks,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConformanceFailure("check-timeout")),
        timeoutMs,
      );
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class ConformanceFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConformanceFailure";
  }
}
