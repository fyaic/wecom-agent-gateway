import { resolve } from "node:path";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LocalGatewayControlClient,
  type LocalControlRequest,
} from "../packages/control-local/src/index.js";
import type { MediaType } from "../packages/runtime-contract/src/index.js";

const operation = process.argv[2];
const client = new LocalGatewayControlClient({
  socketPath: resolve(
    option("--socket") ??
      process.env.GATEWAY_CONTROL_SOCKET ??
      "data/gateway-control.sock",
  ),
  timeoutMs: positiveInteger(
    process.env.GATEWAY_CONTROL_REQUEST_TIMEOUT_MS,
    5_000,
  ),
});

let request: LocalControlRequest;
if (operation === "health") {
  request = { version: LOCAL_CONTROL_PROTOCOL_VERSION, action: "health" };
} else if (operation === "send") {
  const target = requiredOption("--target");
  const text = option("--text");
  const file = option("--file");
  if (Boolean(text) === Boolean(file)) {
    throw new Error("Provide exactly one of --text or --file");
  }
  if (text !== undefined) {
    request = {
      version: LOCAL_CONTROL_PROTOCOL_VERSION,
      action: "send-text",
      target,
      text,
    };
  } else {
    request = {
      version: LOCAL_CONTROL_PROTOCOL_VERSION,
      action: "send-media",
      target,
      media: {
        type: mediaType(requiredOption("--media-type")),
        path: resolve(file!),
        name: option("--name"),
        mimeType: option("--mime-type"),
        title: option("--title"),
        description: option("--description"),
      },
    };
  }
} else {
  throw new Error("Expected operation: health or send");
}

const response = await client.request(request);
if (!response.ok) {
  throw new Error(
    `Gateway control rejected the request: ${response.error.code}`,
  );
}
if (response.action === "health") {
  console.log(JSON.stringify({ event: "gateway_control_health", ready: true }));
} else {
  console.log(
    JSON.stringify({
      event: "gateway_proactive_send",
      kind: response.action === "send-text" ? "text" : "media",
      state: response.state,
      targetType: response.targetType,
    }),
  );
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function mediaType(value: string): MediaType {
  if (["image", "audio", "video", "file"].includes(value)) {
    return value as MediaType;
  }
  throw new Error("--media-type must be image, audio, video, or file");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
