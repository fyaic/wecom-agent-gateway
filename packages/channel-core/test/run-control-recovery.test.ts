import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeAdapter,
  ChannelCapability,
  ChannelTransport,
  DeliveryReceipt,
  DurableOutboundCommand,
  GatewayStore,
  InboundMessage,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import {
  MemoryGatewayStore,
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const inbound: InboundMessage = {
  id: "run-one",
  accountId: "bot",
  conversationId: "chat",
  conversationType: "direct",
  senderId: "user",
  receivedAt: "2026-09-09T00:00:00.000Z",
  parts: [{ type: "text", text: "work" }],
  replyReference: { requestId: "request-one" },
};

class Store extends MemoryGatewayStore {
  readonly enqueued: Array<{ id: string; command: DurableOutboundCommand }> =
    [];
  failSupersede = false;
  override async enqueueDelivery(
    record: Parameters<GatewayStore["enqueueDelivery"]>[0],
  ) {
    const id = await super.enqueueDelivery(record);
    this.enqueued.push({ id, command: record.command });
    return id;
  }
  override async supersedeDelivery(
    record: Parameters<GatewayStore["supersedeDelivery"]>[0],
  ) {
    if (this.failSupersede) throw new Error("injected storage failure");
    return super.supersedeDelivery(record);
  }
}

class Transport implements ChannelTransport {
  readonly id = "fake-control-recovery";
  readonly contractVersion = 1;
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    "stream-reply-update",
    "proactive-message",
    "structured-presentation",
    "interactive-presentation",
  ]);
  online = false;
  readonly commands: OutboundCommand[] = [];
  beforeAck?: (command: OutboundCommand) => Promise<void>;
  private handler!: (message: InboundMessage) => Promise<void>;
  async start(handler: (message: InboundMessage) => Promise<void>) {
    this.handler = handler;
  }
  async stop() {}
  async health() {
    return { ok: this.online };
  }
  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    if (!this.online) throw new Error("fake disconnected");
    this.commands.push(command);
    await this.beforeAck?.(command);
    return { id: "fake-ack", acceptedAt: new Date().toISOString() };
  }
  receive(message = inbound) {
    return this.handler(message);
  }
}

function fixture(store = new Store()) {
  const transport = new Transport();
  const finish = deferred();
  const errors: string[] = [];
  const runtime: AgentRuntimeAdapter = {
    id: "fake-cancellable",
    contractVersion: 1,
    capabilities: new Set(["cancel"]),
    async *run() {
      yield { type: "session-started", sessionId: "session" };
      await finish.promise;
      yield { type: "message-completed", text: "done" };
    },
    async cancel() {
      finish.resolve();
    },
    async health() {
      return { ok: true };
    },
  };
  const gateway = new WeComAgentGateway({
    transport,
    store,
    adapters: [runtime],
    router: new StaticRuntimeRouter(runtime.id),
    runControlAfterMs: 5,
    runControlTimeoutMs: 50,
    outboxPollIntervalMs: 10,
    outboxLeaseMs: 100,
    onInfrastructureError: (event) => errors.push(event.operation),
  });
  return { gateway, transport, store, finish, errors };
}

function control(store: Store) {
  const entry = store.enqueued.find(
    (item) => item.command.type === "proactive-presentation",
  );
  if (!entry || entry.command.type !== "proactive-presentation")
    throw new Error("No queued control");
  return { deliveryId: entry.id, id: entry.command.presentation.id };
}

async function seedControl(store: Store) {
  const id = "run_control_previous_process";
  await store.createRunControl({
    controlId: id,
    accountId: "bot",
    conversationId: "chat",
    senderId: "user",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 50).toISOString(),
  });
  return store.enqueueDelivery({
    messageId: id,
    now: new Date().toISOString(),
    command: {
      type: "proactive-presentation",
      accountId: "bot",
      conversationId: "chat",
      presentation: {
        kind: "actions",
        id,
        title: "running",
        actions: [{ id: "cancel", label: "stop" }],
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-09T00:00:00.000Z");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("run-control outbox lifecycle (fake transport/runtime)", () => {
  it.each(["completed", "cancelled"])(
    "retires an offline %s run's pending card without a receipt or dead letter",
    async (mode) => {
      const f = fixture();
      await f.gateway.start();
      const run = f.transport.receive();
      await vi.advanceTimersByTimeAsync(10);
      const card = control(f.store);
      if (mode === "cancelled") {
        await f.transport.receive({
          ...inbound,
          id: "cancel",
          parts: [],
          interaction: { presentationId: card.id, actionId: "cancel" },
        });
      } else f.finish.resolve();
      await run;
      expect(
        await f.store.claimDelivery({
          deliveryId: card.deliveryId,
          owner: "probe",
          now: new Date().toISOString(),
          leaseUntil: new Date(Date.now() + 100).toISOString(),
        }),
      ).toBeUndefined();
      expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
        delivered: 0,
        dead: 0,
        leased: 0,
      });
      f.transport.online = true;
      await vi.advanceTimersByTimeAsync(20);
      expect(
        f.transport.commands.some(
          (item) => item.type === "proactive-presentation",
        ),
      ).toBe(false);
      expect(f.transport.commands).toContainEqual(
        expect.objectContaining({
          type: "reply",
          final: true,
          text: mode === "cancelled" ? "⏹️ 任务已停止。" : "done",
        }),
      );
      expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
        pending: 0,
        leased: 0,
        dead: 0,
        superseded: 2,
      });
      await f.gateway.stop();
    },
  );

  it("does not send a queued control after its TTL expires while its run is still active", async () => {
    const f = fixture();
    await f.gateway.start();
    const run = f.transport.receive();
    await vi.advanceTimersByTimeAsync(70);
    control(f.store);
    f.transport.online = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(
      f.transport.commands.some(
        (item) => item.type === "proactive-presentation",
      ),
    ).toBe(false);
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
      pending: 0,
      leased: 0,
      dead: 0,
      superseded: 1,
    });
    f.finish.resolve();
    await run;
    expect(f.transport.commands.at(-1)).toMatchObject({
      type: "reply",
      final: true,
      text: "done",
    });
    await f.gateway.stop();
  });

  it("supersedes a previous process's control while still delivering ordinary text", async () => {
    const f = fixture();
    await seedControl(f.store);
    f.transport.online = true;
    await f.gateway.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(
      await f.gateway.sendProactiveText({
        accountId: "bot",
        conversationId: "chat",
        text: "ordinary",
      }),
    ).toBe("delivered");
    expect(f.transport.commands).toEqual([
      expect.objectContaining({ type: "proactive", text: "ordinary" }),
    ]);
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
      pending: 0,
      leased: 0,
      dead: 0,
      delivered: 1,
      superseded: 1,
    });
    await f.gateway.stop();
  });

  it("rechecks a claimed card waiting behind another send after its owning run finishes", async () => {
    const f = fixture();
    const ack = deferred();
    f.transport.online = true;
    f.transport.beforeAck = async (command) => {
      if (command.type === "proactive") await ack.promise;
    };
    await f.gateway.start();
    const run = f.transport.receive();
    await vi.advanceTimersByTimeAsync(1);
    const earlier = f.gateway.sendProactiveText({
      accountId: "bot",
      conversationId: "chat",
      text: "earlier",
    });
    await vi.advanceTimersByTimeAsync(9);
    control(f.store);
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({ leased: 2 });
    f.transport.online = false;
    f.finish.resolve();
    await vi.advanceTimersByTimeAsync(1);
    // Final is durably queued without waiting for the blocked conversation queue.
    expect(f.store.enqueued.at(-1)?.command).toMatchObject({
      type: "reply",
      final: true,
    });
    ack.resolve();
    await earlier;
    await run;
    expect(
      f.transport.commands.some(
        (item) => item.type === "proactive-presentation",
      ),
    ).toBe(false);
    f.transport.online = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(
      f.transport.commands.filter((item) => item.type === "proactive"),
    ).toHaveLength(1);
    expect(f.transport.commands.at(-1)).toMatchObject({
      type: "reply",
      final: true,
      text: "done",
    });
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
      pending: 0,
      leased: 0,
      dead: 0,
      superseded: 1,
    });
    await f.gateway.stop();
  });

  it.each(["ack", "unknown"])(
    "does not rewrite an already-started card's %s result when the run ends",
    async (mode) => {
      const f = fixture();
      const ack = deferred();
      f.transport.online = true;
      f.transport.beforeAck = async (command) => {
        if (command.type === "proactive-presentation") {
          await ack.promise;
          if (mode === "unknown") throw new Error("ACK outcome unknown");
        }
      };
      await f.gateway.start();
      const run = f.transport.receive();
      await vi.advanceTimersByTimeAsync(10);
      expect(
        f.transport.commands.filter(
          (item) => item.type === "proactive-presentation",
        ),
      ).toHaveLength(1);
      f.transport.online = false;
      f.finish.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
        leased: 1,
        superseded: 0,
      });
      ack.resolve();
      await run;
      // A known ACK is still a real delivery. Unknown ACK creates no receipt;
      // giving up its obsolete retry does not assert the first send was absent.
      expect(
        f.store.deliveries.filter(
          (item) =>
            item.command.type === "proactive-presentation" && item.receipt,
        ),
      ).toHaveLength(mode === "ack" ? 1 : 0);
      expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
        dead: 0,
        superseded: mode === "ack" ? 0 : 1,
      });
      f.transport.online = true;
      await vi.advanceTimersByTimeAsync(20);
      expect(
        f.transport.commands.filter(
          (item) => item.type === "proactive-presentation",
        ),
      ).toHaveLength(1);
      await f.gateway.stop();
    },
  );

  it("fails closed on supersede storage failure and recovers its lease without sending a stale card", async () => {
    const f = fixture();
    await seedControl(f.store);
    f.store.failSupersede = true;
    f.transport.online = true;
    await f.gateway.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.transport.commands).toEqual([]);
    expect(f.errors).toContain("supersede-delivery");
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
      leased: 1,
      dead: 0,
      delivered: 0,
      superseded: 0,
    });
    f.store.failSupersede = false;
    await vi.advanceTimersByTimeAsync(110);
    expect(f.transport.commands).toEqual([]);
    expect(await f.store.getDeliveryOutboxStats()).toMatchObject({
      leased: 0,
      pending: 0,
      dead: 0,
      delivered: 0,
      superseded: 1,
    });
    await f.gateway.stop();
  });
});
