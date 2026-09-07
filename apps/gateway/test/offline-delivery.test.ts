import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_TRANSPORT_CONTRACT_VERSION,
  type AgentRuntimeAdapter,
  type ChannelCapability,
  type ChannelTransport,
  type DeliveryReceipt,
  type MediaType,
  type OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import {
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "@fyaic/wecom-channel-core";
import { LocalMediaSpool } from "@fyaic/wecom-media-spool-local";
import { SqliteGatewayStore } from "@fyaic/wecom-storage-sqlite";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class NetworkTransport implements ChannelTransport {
  readonly id = "fake-network";
  readonly contractVersion = CHANNEL_TRANSPORT_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    "proactive-message",
    "media-upload",
    "multimodal-output",
  ]);
  readonly outputModalities: ReadonlySet<MediaType> = new Set(["file"]);
  healthMode: "online" | "offline" | "throws" | "hangs" = "offline";
  rejectDelivery = false;
  attempts = 0;
  commands: OutboundCommand[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<{ ok: boolean }> {
    if (this.healthMode === "throws") throw new Error("probe unavailable");
    if (this.healthMode === "hangs") return new Promise(() => {});
    return { ok: this.healthMode === "online" };
  }
  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    this.attempts++;
    if (this.rejectDelivery || this.healthMode !== "online")
      throw new Error("delivery rejected");
    if (command.type === "proactive-media")
      expect(readFileSync(command.media.path!, "utf8")).toBe(
        "durable media bytes",
      );
    this.commands.push(command);
    return {
      id: `receipt-${this.commands.length}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}

const runtime: AgentRuntimeAdapter = {
  id: "unused",
  contractVersion: 1,
  capabilities: new Set(),
  async *run() {
    throw new Error("outbound recovery must not call a Kernel");
  },
  async health() {
    return { ok: true };
  },
};

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const root = mkdtempSync(join(tmpdir(), "gateway-offline-budget-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "gateway-offline-source-"));
  directories.push(root, sourceRoot);
  const source = join(sourceRoot, "report.txt");
  writeFileSync(source, "durable media bytes", { mode: 0o600 });
  const databasePath = join(root, "gateway.db");
  const transport = new NetworkTransport();
  const open = () => {
    const store = new SqliteGatewayStore(databasePath);
    const gateway = new WeComAgentGateway({
      transport,
      store,
      adapters: [runtime],
      router: new StaticRuntimeRouter(runtime.id),
      mediaSpool: new LocalMediaSpool({
        root: join(root, "spool"),
        sourceRoots: [sourceRoot],
      }),
      outboxMaxAttempts: 3,
      outboxRetryBaseMs: 1_000,
      outboxPollIntervalMs: 1_000,
    });
    return { store, gateway };
  };
  const rows = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT status, attempts, command_json FROM delivery_outbox ORDER BY rowid",
        )
        .all();
    } finally {
      database.close();
    }
  };
  return { transport, open, rows, source };
}

describe("offline delivery budget", () => {
  it("retains text and media for a 90-second outage and restart, then delivers on reconnect", async () => {
    const fixture = setup();
    let { gateway, store } = fixture.open();
    await gateway.start();
    try {
      expect(
        await gateway.sendProactiveText({
          accountId: "bot",
          conversationId: "chat",
          text: "queued text",
        }),
      ).toBe("queued");
      expect(
        await gateway.sendProactiveMedia({
          accountId: "bot",
          conversationId: "chat",
          media: { type: "file", path: fixture.source },
        }),
      ).toBe("queued");
      unlinkSync(fixture.source);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([
        { status: "pending", attempts: 0 },
        { status: "pending", attempts: 0 },
      ]);
      expect(await store.listReferencedMediaArtifactIds()).toHaveLength(1);
      await gateway.stop();
      store.close();
      ({ gateway, store } = fixture.open());
      await gateway.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.transport.attempts).toBe(0);
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([
        { status: "pending", attempts: 0 },
        { status: "pending", attempts: 0 },
      ]);
      fixture.transport.healthMode = "online";
      await vi.advanceTimersByTimeAsync(2_000);
      // The delivery includes real asynchronous filesystem materialization.
      await gateway.stop();
      expect(fixture.transport.commands.map((command) => command.type)).toEqual(
        ["proactive", "proactive-media"],
      );
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([
        { status: "delivered", attempts: 1 },
        { status: "delivered", attempts: 1 },
      ]);
      const media = fixture.transport.commands[1]!;
      if (media.type !== "proactive-media") throw new Error("missing media");
      expect(existsSync(media.media.path!)).toBe(false);
      expect(await store.listReferencedMediaArtifactIds()).toEqual([]);
    } finally {
      await gateway.stop();
      store.close();
    }
  });

  it("still exhausts a healthy transport's permanent delivery failures", async () => {
    const fixture = setup();
    fixture.transport.healthMode = "online";
    fixture.transport.rejectDelivery = true;
    const { gateway, store } = fixture.open();
    await gateway.start();
    try {
      expect(
        await gateway.sendProactiveText({
          accountId: "bot",
          conversationId: "chat",
          text: "permanent API rejection",
        }),
      ).toBe("queued");
      await vi.advanceTimersByTimeAsync(20_000);
      await gateway.stop();
      expect(fixture.transport.attempts).toBe(3);
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([{ status: "dead", attempts: 3 }]);
      expect(await store.listReferencedMediaArtifactIds()).toEqual([]);
    } finally {
      await gateway.stop();
      store.close();
    }
  });

  it("preserves existing failed attempts across a later offline interval", async () => {
    const fixture = setup();
    fixture.transport.healthMode = "online";
    fixture.transport.rejectDelivery = true;
    const { gateway, store } = fixture.open();
    await gateway.start();
    try {
      expect(
        await gateway.sendProactiveText({
          accountId: "bot",
          conversationId: "chat",
          text: "retry after reconnect",
        }),
      ).toBe("queued");
      fixture.transport.healthMode = "offline";
      await vi.advanceTimersByTimeAsync(90_000);
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([{ status: "pending", attempts: 1 }]);
      expect(fixture.transport.attempts).toBe(1);
      fixture.transport.healthMode = "online";
      fixture.transport.rejectDelivery = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([{ status: "delivered", attempts: 2 }]);
    } finally {
      await gateway.stop();
      store.close();
    }
  });

  it("preserves the legacy delivery path when no health method is present", async () => {
    const fixture = setup();
    fixture.transport.healthMode = "online";
    Object.defineProperty(fixture.transport, "health", { value: undefined });
    const { gateway, store } = fixture.open();
    await gateway.start();
    try {
      expect(
        await gateway.sendProactiveText({
          accountId: "bot",
          conversationId: "chat",
          text: "legacy",
        }),
      ).toBe("delivered");
      expect(
        fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
      ).toEqual([{ status: "delivered", attempts: 1 }]);
    } finally {
      await gateway.stop();
      store.close();
    }
  });

  it.each(["throws", "hangs"] as const)(
    "fails closed with a bounded %s health probe without consuming attempts",
    async (mode) => {
      const fixture = setup();
      fixture.transport.healthMode = mode;
      const { gateway, store } = fixture.open();
      await gateway.start();
      try {
        const request = gateway.sendProactiveText({
          accountId: "bot",
          conversationId: "chat",
          text: "pending",
        });
        await vi.advanceTimersByTimeAsync(1_001);
        expect(await request).toBe("queued");
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fixture.transport.attempts).toBe(0);
        expect(
          fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
        ).toEqual([{ status: "pending", attempts: 0 }]);
        fixture.transport.healthMode = "online";
        await vi.advanceTimersByTimeAsync(3_000);
        await gateway.stop();
        expect(
          fixture.rows().map(({ status, attempts }) => ({ status, attempts })),
        ).toEqual([{ status: "delivered", attempts: 1 }]);
      } finally {
        await gateway.stop();
        store.close();
      }
    },
  );
});
