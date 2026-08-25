import { performance } from "node:perf_hooks";
import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";

const adapter = await createConfiguredAdapter({
  env: { ...process.env, GATEWAY_ADAPTER: "openclaw" },
  tools: [],
});
await adapter.start?.();
const health = await adapter.health();
if (!health.ok)
  throw new Error(health.detail ?? "OpenClaw adapter is unhealthy");

let sessionId: string | undefined;
const turns = [];
for (const [index, text] of [
  "Reply with exactly: OPENCLAW_ONE",
  "Reply with exactly: OPENCLAW_TWO",
].entries()) {
  const startedAt = performance.now();
  let firstTextMs: number | undefined;
  let finalText = "";
  for await (const event of adapter.run({
    sessionId,
    message: {
      id: `openclaw-smoke-${index + 1}`,
      accountId: "local-smoke",
      conversationId: "local-smoke",
      conversationType: "direct",
      senderId: "local-smoke",
      receivedAt: new Date().toISOString(),
      parts: [{ type: "text", text }],
    },
  })) {
    if (event.type === "session-started") sessionId = event.sessionId;
    if (event.type === "text-delta" && firstTextMs === undefined) {
      firstTextMs = performance.now() - startedAt;
    }
    if (event.type === "message-completed") finalText = event.text ?? "";
    if (event.type === "failed") throw new Error(event.message);
  }
  turns.push({
    turn: index + 1,
    firstTextMs: Math.round(firstTextMs ?? 0),
    completedMs: Math.round(performance.now() - startedAt),
    exactReply:
      finalText.trim() === (index === 0 ? "OPENCLAW_ONE" : "OPENCLAW_TWO"),
  });
}
await adapter.stop?.();
console.log(
  JSON.stringify({
    event: "openclaw_adapter_smoke_completed",
    resumed: Boolean(sessionId),
    turns,
  }),
);
