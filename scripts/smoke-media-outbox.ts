import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBotOwnerLock } from "../apps/gateway/src/bot-owner-lock.js";
import type { DeliveryLifecycleEvent } from "../packages/channel-core/src/index.js";
import {
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "../packages/channel-core/src/index.js";
import { LocalMediaSpool } from "../packages/media-spool-local/src/index.js";
import { SqliteGatewayStore } from "../packages/storage-sqlite/src/index.js";
import { WeComBotTransport } from "../packages/transport-wecom-bot/src/index.js";
import type { AgentRuntimeAdapter } from "../packages/runtime-contract/src/index.js";

const confirmation = "--confirm-send-to-authorized-direct";
if (!process.argv.includes(confirmation)) {
  throw new Error(`Real send disabled; pass ${confirmation} to continue`);
}

const botId = required("WECOM_BOT_ID");
const secret = required("WECOM_BOT_SECRET");
const botOwner = await acquireBotOwnerLock({
  accountId: botId,
  root: process.env.GATEWAY_OWNER_LOCK_ROOT || undefined,
});
const targets = list("WECOM_ALLOWED_DIRECT_SENDERS");
if (targets.length !== 1) {
  throw new Error(
    "Media outbox smoke requires exactly one scoped authorized direct sender",
  );
}

const directory = await mkdtemp(join(tmpdir(), "wecom-media-outbox-smoke-"));
const sourceRoot = join(directory, "source");
const spoolRoot = join(directory, "spool");
const databasePath = join(directory, "gateway.db");
await mkdir(sourceRoot, { mode: 0o700 });
const source = join(sourceRoot, "wecom-gateway-media-outbox-smoke.txt");
await writeFile(
  source,
  [
    "wecom-agent-gateway media outbox smoke",
    "This file was delivered after durable spooling and simulated restart.",
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);

let firstStore: SqliteGatewayStore | undefined;
let secondStore: SqliteGatewayStore | undefined;
let gateway: WeComAgentGateway | undefined;
try {
  const firstSpool = new LocalMediaSpool({
    root: spoolRoot,
    sourceRoots: [sourceRoot],
  });
  await firstSpool.start();
  const artifact = await firstSpool.stage({
    type: "file",
    path: source,
    name: "wecom-gateway-media-outbox-smoke.txt",
    mimeType: "text/plain",
  });
  firstStore = new SqliteGatewayStore(databasePath);
  await firstStore.enqueueDelivery({
    messageId: "real-media-outbox-smoke",
    command: {
      type: "proactive-media",
      accountId: botId,
      conversationId: targets[0] as string,
      media: artifact,
    },
    now: new Date(0).toISOString(),
  });
  firstStore.close();
  firstStore = undefined;
  await unlink(source);

  const transport = new WeComBotTransport({
    accountId: botId,
    botId,
    secret,
    mediaOutputRoots: [spoolRoot],
  });
  const runtime: AgentRuntimeAdapter = {
    id: "smoke-unused-runtime",
    contractVersion: 1,
    capabilities: new Set(),
    async *run() {},
    async health() {
      return { ok: true };
    },
  };
  secondStore = new SqliteGatewayStore(databasePath);
  const secondSpool = new LocalMediaSpool({
    root: spoolRoot,
    sourceRoots: [sourceRoot],
  });
  let outcome: DeliveryLifecycleEvent["phase"] | undefined;
  gateway = new WeComAgentGateway({
    transport,
    adapters: [runtime],
    router: new StaticRuntimeRouter(runtime.id),
    store: secondStore,
    mediaSpool: secondSpool,
    outboxPollIntervalMs: 100,
    onDeliveryLifecycleEvent: (event) => {
      if (
        event.commandType === "proactive-media" &&
        (event.phase === "delivered" || event.phase === "dead-lettered")
      ) {
        outcome = event.phase;
      }
    },
  });
  await gateway.start();
  await waitFor(() => outcome !== undefined, 30_000);
  if (outcome !== "delivered") {
    throw new Error("Media outbox smoke reached dead letter");
  }
  console.log(
    JSON.stringify({
      event: "media_outbox_smoke",
      status: "delivered",
      targetType: "authorized-direct",
      simulatedRestart: true,
    }),
  );
} finally {
  if (gateway) await gateway.stop();
  firstStore?.close();
  secondStore?.close();
  await rm(directory, { recursive: true, force: true });
  await botOwner.release();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for delivery");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
