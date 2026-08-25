import { access } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";
import type {
  AgentRunEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";

if (!process.argv.includes("--confirm-real-pi")) {
  throw new Error(
    "Refusing to call the real Pi vision model without --confirm-real-pi",
  );
}

const imagePath = process.env.PI_SMOKE_IMAGE_PATH;
const expectedText = process.env.PI_SMOKE_EXPECT;
if (!imagePath || !expectedText) {
  throw new Error("PI_SMOKE_IMAGE_PATH and PI_SMOKE_EXPECT are required");
}

const absoluteImagePath = resolve(imagePath);
await access(absoluteImagePath);

const adapter = await createConfiguredAdapter({
  env: { ...process.env, GATEWAY_ADAPTER: "pi" },
  tools: [],
});

try {
  const startedAt = performance.now();
  await adapter.start?.();
  const health = await adapter.health();
  if (!health.ok) throw new Error("Pi RPC adapter is unhealthy");
  if (!adapter.capabilities.has("multimodal-input")) {
    throw new Error("Selected Pi model did not negotiate image input");
  }

  const events: AgentRunEvent[] = [];
  for await (const event of adapter.run({
    message: message(absoluteImagePath),
  })) {
    events.push(event);
  }

  const failed = events.find((event) => event.type === "failed");
  if (failed?.type === "failed") throw new Error(failed.message);
  const completed = events.find((event) => event.type === "message-completed");
  if (completed?.type !== "message-completed") {
    throw new Error("Pi RPC vision turn did not complete");
  }
  if (!completed.text?.includes(expectedText)) {
    throw new Error("Pi RPC vision response did not contain expected text");
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "pi_image_adapter_smoke_completed",
      adapter: adapter.id,
      protocol: "official JSONL RPC",
      multimodalInput: true,
      expectedTextMatched: true,
      totalMs: Math.round(performance.now() - startedAt),
    })}\n`,
  );
} finally {
  await adapter.stop?.();
}

function message(path: string): InboundMessage {
  return {
    id: "pi-image-smoke-1",
    accountId: "local-smoke",
    conversationId: "local-smoke",
    conversationType: "direct",
    senderId: "local-smoke",
    receivedAt: new Date().toISOString(),
    parts: [
      {
        type: "text",
        text: "只抄录图片中红色提示框内的终端命令，不要解释。",
      },
      {
        type: "image",
        path,
        mimeType: mimeType(path),
      },
    ],
  };
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}
