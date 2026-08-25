import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteGatewayStore } from "../packages/storage-sqlite/src/index.js";

const databasePath = resolve(
  process.env.GATEWAY_DATABASE_PATH ?? "data/gateway.db",
);
if (!existsSync(databasePath)) {
  throw new Error("Gateway database does not exist; refusing to create it");
}

const operation = process.argv[2];
const store = new SqliteGatewayStore(databasePath);
try {
  if (operation === "status") {
    console.log(
      JSON.stringify({
        event: "outbox_status",
        counts: await store.getDeliveryOutboxStats(),
      }),
    );
  } else if (operation === "replay-text") {
    const confirmation = "--confirm-requeue-terminal-text";
    if (!process.argv.includes(confirmation)) {
      throw new Error(`Replay disabled; pass ${confirmation} to continue`);
    }
    const limit = replayLimit(process.argv);
    const requeued = await store.requeueDeadTextDeliveries({
      limit,
      now: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        event: "outbox_requeue",
        commandClass: "terminal-text-only",
        requestedLimit: limit,
        requeued,
        counts: await store.getDeliveryOutboxStats(),
      }),
    );
  } else {
    throw new Error("Expected operation: status or replay-text");
  }
} finally {
  store.close();
}

function replayLimit(argv: string[]): number {
  const argument = argv.find((item) => item.startsWith("--limit="));
  if (!argument) return 10;
  const value = Number(argument.slice("--limit=".length));
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Replay limit must be an integer from 1 to 100");
  }
  return value;
}
