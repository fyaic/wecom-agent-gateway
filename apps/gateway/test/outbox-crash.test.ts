import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntimeAdapter,
  ChannelCapability,
  ChannelTransport,
  DeliveryReceipt,
  InboundMessage,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import {
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "@fyaic/wecom-channel-core";
import { SqliteGatewayStore } from "@fyaic/wecom-storage-sqlite";

const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  children.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("process crash recovery", () => {
  it("reclaims and delivers a SQLite outbox lease after SIGKILL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-sigkill-recovery-"));
    directories.push(directory);
    const databasePath = join(directory, "gateway.db");
    const workerPath = join(
      import.meta.dirname,
      "fixtures",
      "outbox-crash-worker.ts",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, databasePath],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    await waitForOutput(child, "DELIVERY_STARTED", stderr);
    expect(child.kill("SIGKILL")).toBe(true);
    const [exitCode, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    children.delete(child);
    expect(exitCode).toBeNull();
    expect(signal).toBe("SIGKILL");

    const crashedStore = new SqliteGatewayStore(databasePath);
    await expect(crashedStore.getDeliveryOutboxStats()).resolves.toMatchObject({
      leased: 1,
      delivered: 0,
      dead: 0,
    });
    crashedStore.close();

    const commands: OutboundCommand[] = [];
    class RecoveryTransport implements ChannelTransport {
      readonly id = "recovery-transport";
      readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
        "proactive-message",
      ]);
      async start(
        _onMessage: (message: InboundMessage) => Promise<void>,
      ): Promise<void> {}
      async stop(): Promise<void> {}
      async health(): Promise<{ ok: boolean }> {
        return { ok: true };
      }
      async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
        commands.push(command);
        return { id: "recovered", acceptedAt: new Date().toISOString() };
      }
    }
    const runtime: AgentRuntimeAdapter = {
      id: "unused-recovery-runtime",
      contractVersion: 1,
      capabilities: new Set(),
      async *run() {},
      async health() {
        return { ok: true };
      },
    };
    const recoveredStore = new SqliteGatewayStore(databasePath);
    const gateway = new WeComAgentGateway({
      transport: new RecoveryTransport(),
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      store: recoveredStore,
      outboxPollIntervalMs: 5,
    });
    await gateway.start();
    await waitFor(async () => {
      const stats = await recoveredStore.getDeliveryOutboxStats();
      return stats.delivered === 1;
    });
    await gateway.stop();

    expect(commands).toEqual([
      {
        type: "proactive",
        accountId: "bot",
        conversationId: "authorized-conversation",
        text: "durable across SIGKILL",
      },
    ]);
    await expect(
      recoveredStore.getDeliveryOutboxStats(),
    ).resolves.toMatchObject({
      pending: 0,
      leased: 0,
      delivered: 1,
      dead: 0,
    });
    recoveredStore.close();
  }, 10_000);
});

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  stderr: Buffer[],
  timeoutMs = 5_000,
): Promise<void> {
  let output = "";
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for child output; stderr=${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk: string) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(
        new Error(
          `Child exited before readiness; stderr=${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
