import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";
import type {
  AgentRunEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";

if (!process.argv.includes("--confirm-real-pi")) {
  throw new Error(
    "Refusing to call the real Pi model without --confirm-real-pi",
  );
}

const adapter = await createConfiguredAdapter({
  env: { ...process.env, GATEWAY_ADAPTER: "pi" },
  tools: [],
});

try {
  const startedAt = performance.now();
  await adapter.start?.();
  const health = await adapter.health();
  if (!health.ok) throw new Error("Pi RPC adapter is unhealthy");
  const firstStartedAt = performance.now();
  const first = await turn(
    message(
      "pi-smoke-1",
      "只回复纯文本 PI_RPC_OK，不要使用工具，不要添加标点或其他内容。",
    ),
  );
  const firstMs = Math.round(performance.now() - firstStartedAt);
  if (!first.sessionId || first.text.trim() !== "PI_RPC_OK") {
    throw new Error("Pi RPC first turn did not match the smoke contract");
  }
  const resumedStartedAt = performance.now();
  const resumed = await turn(
    message(
      "pi-smoke-2",
      "只回复纯文本 PI_RPC_RESUME_OK，不要使用工具，不要添加标点或其他内容。",
    ),
    first.sessionId,
  );
  const resumedMs = Math.round(performance.now() - resumedStartedAt);
  if (resumed.text.trim() !== "PI_RPC_RESUME_OK") {
    throw new Error("Pi RPC resumed turn did not match the smoke contract");
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "pi_adapter_smoke_completed",
      adapter: adapter.id,
      protocol: "official JSONL RPC",
      streaming: adapter.capabilities.has("streaming"),
      resume: adapter.capabilities.has("resume"),
      multimodalInput: adapter.capabilities.has("multimodal-input"),
      firstMs,
      resumedMs,
      totalMs: Math.round(performance.now() - startedAt),
    })}\n`,
  );
} finally {
  await adapter.stop?.();
}

async function turn(
  inbound: InboundMessage,
  sessionId?: string,
): Promise<{ sessionId?: string; text: string }> {
  const events: AgentRunEvent[] = [];
  for await (const event of adapter.run({ message: inbound, sessionId })) {
    events.push(event);
  }
  const failed = events.find((event) => event.type === "failed");
  if (failed?.type === "failed") throw new Error(failed.message);
  const started = events.find((event) => event.type === "session-started");
  const completed = events.find((event) => event.type === "message-completed");
  if (completed?.type !== "message-completed") {
    throw new Error("Pi RPC turn did not complete");
  }
  return {
    sessionId:
      started?.type === "session-started" ? started.sessionId : sessionId,
    text: completed.text ?? "",
  };
}

function message(id: string, text: string): InboundMessage {
  return {
    id,
    accountId: "local-smoke",
    conversationId: "local-smoke",
    conversationType: "direct",
    senderId: "local-smoke",
    receivedAt: new Date().toISOString(),
    parts: [{ type: "text", text }],
  };
}
