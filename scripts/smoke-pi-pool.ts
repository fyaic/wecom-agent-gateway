import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";
import type {
  AgentRunEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";

if (!process.argv.includes("--confirm-real-pi")) {
  throw new Error(
    "Refusing to call the real Pi models without --confirm-real-pi",
  );
}

const adapter = await createConfiguredAdapter({
  env: { ...process.env, GATEWAY_ADAPTER: "pi", PI_MAX_WORKERS: "2" },
  tools: [],
});

try {
  await adapter.start?.();
  const startedAt = performance.now();
  const [first, second] = await Promise.all([
    turn(
      message(
        "pi-pool-a",
        "只回复纯文本 PI_POOL_A_OK，不要添加标点或其他内容。",
      ),
    ),
    turn(
      message(
        "pi-pool-b",
        "只回复纯文本 PI_POOL_B_OK，不要添加标点或其他内容。",
      ),
    ),
  ]);
  const totalMs = Math.round(performance.now() - startedAt);
  if (first.text.trim() !== "PI_POOL_A_OK") {
    throw new Error("Pi pool worker A did not match the smoke contract");
  }
  if (second.text.trim() !== "PI_POOL_B_OK") {
    throw new Error("Pi pool worker B did not match the smoke contract");
  }
  const health = await adapter.health();
  if (!health.ok) throw new Error("Pi worker pool is unhealthy");
  process.stdout.write(
    `${JSON.stringify({
      event: "pi_pool_smoke_completed",
      workers: 2,
      distinctSessions: true,
      firstMs: first.elapsedMs,
      secondMs: second.elapsedMs,
      totalMs,
      overlapped: totalMs < first.elapsedMs + second.elapsedMs,
    })}\n`,
  );
} finally {
  await adapter.stop?.();
}

async function turn(
  inbound: InboundMessage,
): Promise<{ elapsedMs: number; text: string }> {
  const startedAt = performance.now();
  const events: AgentRunEvent[] = [];
  for await (const event of adapter.run({ message: inbound })) {
    events.push(event);
  }
  const failed = events.find((event) => event.type === "failed");
  if (failed?.type === "failed") throw new Error(failed.message);
  const completed = events.find((event) => event.type === "message-completed");
  if (completed?.type !== "message-completed") {
    throw new Error("Pi pool turn did not complete");
  }
  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    text: completed.text ?? "",
  };
}

function message(id: string, text: string): InboundMessage {
  return {
    id,
    accountId: "local-smoke",
    conversationId: id,
    conversationType: "direct",
    senderId: "local-smoke",
    receivedAt: new Date().toISOString(),
    parts: [{ type: "text", text }],
  };
}
