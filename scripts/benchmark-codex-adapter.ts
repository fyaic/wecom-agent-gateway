import { CodexAppServerRuntimeAdapter } from "../packages/adapter-codex/src/index.js";
import type { InboundMessage } from "../packages/runtime-contract/src/index.js";

const adapter = new CodexAppServerRuntimeAdapter({
  cwd: process.env.CODEX_WORKING_DIRECTORY ?? process.cwd(),
  executable: process.env.CODEX_EXECUTABLE || undefined,
  codexHome: process.env.CODEX_RUNTIME_HOME || undefined,
  model: process.env.CODEX_MODEL || undefined,
  serviceTier: process.env.CODEX_SERVICE_TIER || undefined,
  effort: reasoningEffort(process.env.CODEX_REASONING_EFFORT),
  sandbox: "read-only",
  approvalPolicy: "never",
  responsesWebsocket: process.env.CODEX_RESPONSES_WEBSOCKET === "true",
  onStderr: () => undefined,
});

const processStartedAt = performance.now();
await adapter.start();
const adapterStartMs = elapsed(processStartedAt);
let sessionId: string | undefined;
const turns = [];

try {
  for (let index = 1; index <= 2; index += 1) {
    const startedAt = performance.now();
    let firstEventMs: number | undefined;
    let firstTextMs: number | undefined;
    let completed = false;
    for await (const event of adapter.run({
      message: benchmarkMessage(index),
      sessionId,
    })) {
      firstEventMs ??= elapsed(startedAt);
      if (event.type === "session-started") sessionId = event.sessionId;
      if (event.type === "text-delta") firstTextMs ??= elapsed(startedAt);
      if (event.type === "message-completed") completed = true;
      if (event.type === "failed") throw new Error(event.message);
    }
    turns.push({
      turn: index,
      firstEventMs,
      firstTextMs,
      totalMs: elapsed(startedAt),
      completed,
    });
  }
} finally {
  await adapter.stop();
}

console.log(
  JSON.stringify({
    adapterId: adapter.id,
    adapterStartMs,
    model: process.env.CODEX_MODEL || "configured-default",
    serviceTier: process.env.CODEX_SERVICE_TIER || "configured-default",
    effort: reasoningEffort(process.env.CODEX_REASONING_EFFORT) ?? null,
    turns,
  }),
);

function benchmarkMessage(index: number): InboundMessage {
  return {
    id: `benchmark-${index}`,
    accountId: "benchmark",
    conversationId: "benchmark",
    conversationType: "direct",
    senderId: "benchmark",
    receivedAt: new Date().toISOString(),
    parts: [
      {
        type: "text",
        text:
          process.env.CODEX_BENCHMARK_PROMPT ??
          "这是链路延迟测试。请只回复两个大写字母：OK",
      },
    ],
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function reasoningEffort(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as "minimal" | "low" | "medium" | "high" | "xhigh";
  }
  throw new Error(`Invalid CODEX_REASONING_EFFORT: ${value}`);
}
