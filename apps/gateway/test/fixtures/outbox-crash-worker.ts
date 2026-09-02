import type {
  AgentRuntimeAdapter,
  ChannelCapability,
  ChannelTransport,
  DeliveryReceipt,
  InboundMessage,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import { CHANNEL_TRANSPORT_CONTRACT_VERSION } from "@fyaic/wecom-runtime-contract";
import {
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "@fyaic/wecom-channel-core";
import { SqliteGatewayStore } from "@fyaic/wecom-storage-sqlite";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("A SQLite database path is required");

class BlockingTransport implements ChannelTransport {
  readonly id = "blocking-crash-transport";
  readonly contractVersion = CHANNEL_TRANSPORT_CONTRACT_VERSION;
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

  async deliver(_command: OutboundCommand): Promise<DeliveryReceipt> {
    process.stdout.write("DELIVERY_STARTED\n");
    return new Promise<DeliveryReceipt>(() => undefined);
  }
}

const runtime: AgentRuntimeAdapter = {
  id: "unused-crash-runtime",
  contractVersion: 1,
  capabilities: new Set(),
  async *run() {},
  async health() {
    return { ok: true };
  },
};

const gateway = new WeComAgentGateway({
  transport: new BlockingTransport(),
  adapters: [runtime],
  router: new StaticRuntimeRouter(runtime.id),
  store: new SqliteGatewayStore(databasePath),
  outboxLeaseMs: 100,
});

await gateway.start();
void gateway.sendProactiveText({
  accountId: "bot",
  conversationId: "authorized-conversation",
  text: "durable across SIGKILL",
});

// An unresolved promise does not keep Node alive. This process is intentionally
// kept running until the parent test delivers SIGKILL while delivery is leased.
setInterval(() => undefined, 1_000);
