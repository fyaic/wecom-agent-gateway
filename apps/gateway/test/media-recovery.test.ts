import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntimeAdapter,
  ChannelCapability,
  ChannelTransport,
  DeliveryReceipt,
  InboundMessage,
  MediaType,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import { CHANNEL_TRANSPORT_CONTRACT_VERSION } from "@fyaic/wecom-runtime-contract";
import { LocalMediaSpool } from "@fyaic/wecom-media-spool-local";
import {
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "@fyaic/wecom-channel-core";
import { SqliteGatewayStore } from "@fyaic/wecom-storage-sqlite";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable media recovery", () => {
  it("sends a spooled artifact after process restart and then releases it", async () => {
    const directory = temporary("wecom-media-recovery-");
    const sourceRoot = temporary("wecom-media-recovery-source-");
    const databasePath = join(directory, "gateway.db");
    const spoolRoot = join(directory, "media-spool");
    const source = join(sourceRoot, "generated.png");
    writeFileSync(source, "generated-image", { mode: 0o600 });
    const firstSpool = new LocalMediaSpool({
      root: spoolRoot,
      sourceRoots: [sourceRoot],
    });
    await firstSpool.start();
    const artifact = await firstSpool.stage({
      type: "image",
      path: source,
      name: "generated.png",
    });
    const artifactPath = (await firstSpool.materialize(artifact)).path;
    const firstStore = new SqliteGatewayStore(databasePath);
    await firstStore.enqueueDelivery({
      messageId: "media-after-restart",
      command: {
        type: "proactive-media",
        accountId: "bot",
        conversationId: "chat",
        media: artifact,
      },
      now: new Date(0).toISOString(),
    });
    firstStore.close();
    unlinkSync(source);

    class RecoveryTransport implements ChannelTransport {
      readonly id = "recovery-transport";
      readonly contractVersion = CHANNEL_TRANSPORT_CONTRACT_VERSION;
      readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "media-upload",
        "multimodal-output",
      ]);
      readonly outputModalities: ReadonlySet<MediaType> = new Set(["image"]);
      readonly commands: OutboundCommand[] = [];
      async start(
        _onMessage: (message: InboundMessage) => Promise<void>,
      ): Promise<void> {}
      async stop(): Promise<void> {}
      async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
        this.commands.push(command);
        return { id: "accepted", acceptedAt: new Date().toISOString() };
      }
      async health(): Promise<{ ok: boolean }> {
        return { ok: true };
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "unused-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {},
      async health() {
        return { ok: true };
      },
    };
    const transport = new RecoveryTransport();
    const secondStore = new SqliteGatewayStore(databasePath);
    const secondSpool = new LocalMediaSpool({
      root: spoolRoot,
      sourceRoots: [sourceRoot],
    });
    const gateway = new WeComAgentGateway({
      transport,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: secondStore,
      mediaSpool: secondSpool,
      outboxPollIntervalMs: 2,
    });
    await gateway.start();
    await waitFor(() => transport.commands.length === 1);
    await gateway.stop();
    secondStore.close();

    expect(transport.commands[0]).toMatchObject({
      type: "proactive-media",
      media: {
        path: artifactPath,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
    });
    expect(existsSync(artifactPath)).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare("SELECT status, attempts FROM delivery_outbox")
      .get() as { status: string; attempts: number };
    database.close();
    expect(row).toEqual({ status: "delivered", attempts: 1 });
  });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
