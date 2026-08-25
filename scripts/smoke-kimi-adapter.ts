import type {
  AgentRunEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";
import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";

if (!process.argv.includes("--confirm-real-kimi")) {
  throw new Error(
    "Refusing to call the real Kimi account without --confirm-real-kimi",
  );
}

const adapter = await createConfiguredAdapter({
  env: { ...process.env, GATEWAY_ADAPTER: "kimi" },
  tools: [],
});
const startedAt = Date.now();
await adapter.start?.();
try {
  const health = await adapter.health();
  if (!health.ok) throw new Error("Kimi ACP adapter is unhealthy");

  const first = await run(
    message(
      "kimi-smoke-1",
      "只回复纯文本 KIMI_ACP_OK，不要使用工具，不要添加标点或其他内容。",
    ),
  );
  if (!first.sessionId || first.text.trim() !== "KIMI_ACP_OK") {
    throw new Error("Kimi ACP first turn did not match the smoke contract");
  }
  const resumed = await run(
    message(
      "kimi-smoke-2",
      "只回复纯文本 KIMI_ACP_RESUME_OK，不要使用工具，不要添加标点或其他内容。",
    ),
    first.sessionId,
  );
  if (resumed.text.trim() !== "KIMI_ACP_RESUME_OK") {
    throw new Error("Kimi ACP resumed turn did not match the smoke contract");
  }

  console.log(
    JSON.stringify({
      ok: true,
      adapterId: adapter.id,
      protocol: "ACP v1",
      streaming: first.deltaCount > 0 && resumed.deltaCount > 0,
      resume: true,
      multimodalInput: adapter.capabilities.has("multimodal-input"),
      elapsedMs: Date.now() - startedAt,
    }),
  );
} finally {
  await adapter.stop?.();
}

async function run(
  inbound: InboundMessage,
  sessionId?: string,
): Promise<{ sessionId?: string; text: string; deltaCount: number }> {
  let activeSession = sessionId;
  let text = "";
  let deltaCount = 0;
  for await (const event of adapter.run({ message: inbound, sessionId })) {
    if (event.type === "session-started") activeSession = event.sessionId;
    if (event.type === "text-delta") {
      text += event.text;
      deltaCount += 1;
    }
    if (event.type === "failed") throw new Error(event.message);
    assertNoUnexpectedOutput(event);
  }
  return { sessionId: activeSession, text, deltaCount };
}

function message(id: string, text: string): InboundMessage {
  return {
    id,
    accountId: "smoke",
    conversationId: "smoke",
    conversationType: "direct",
    senderId: "operator",
    receivedAt: new Date().toISOString(),
    parts: [{ type: "text", text }],
  };
}

function assertNoUnexpectedOutput(event: AgentRunEvent): void {
  if (event.type === "media-output" || event.type === "approval-requested") {
    throw new Error(`Unexpected Kimi smoke event: ${event.type}`);
  }
}
