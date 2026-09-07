import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AllowlistPolicy,
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "../packages/channel-core/src/index.js";
import { SqliteGatewayStore } from "../packages/storage-sqlite/src/index.js";
import { LoopbackTransport } from "../packages/transport-loopback/src/index.js";
import {
  GatewayMetrics,
  LocalObservabilityServer,
} from "../packages/observability-local/src/index.js";
import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";

/** Credential-free deployment fixture: actual Core/SQLite, fake channel and Agent. */
export async function startLinuxLab(databasePath: string, port = 9_464) {
  const store = new SqliteGatewayStore(databasePath);
  const scope = {
    accountId: "linux-lab",
    conversationId: "linux-lab",
    adapterId: "example:v1",
  };
  const transport = new LoopbackTransport();
  const errors: Error[] = [];
  const adapter = await createConfiguredAdapter({
    env: {
      GATEWAY_ADAPTER: "external",
      GATEWAY_EXTERNAL_ADAPTER_MODULE:
        "./examples/adapter-template/src/index.ts",
      GATEWAY_EXTERNAL_ADAPTER_BASE_DIRECTORY: fileURLToPath(
        new URL("../", import.meta.url),
      ),
    },
    tools: [],
  });
  const gateway = new WeComAgentGateway({
    adapters: [adapter],
    transport,
    store,
    router: new StaticRuntimeRouter(adapter.id),
    policy: new AllowlistPolicy({ allowedDirectSenders: ["lab-user"] }),
    onRuntimeError: (error) => errors.push(error),
    onInfrastructureError: (event) => errors.push(event.error),
  });
  const observability = new LocalObservabilityServer({
    host: "127.0.0.1",
    port,
    snapshot: () => gateway.operationalSnapshot(),
    metrics: new GatewayMetrics(),
  });
  const stop = async () => {
    await observability.stop();
    await gateway.stop();
    store.close();
  };
  try {
    const previousSession = await store.getSession(scope);
    await gateway.start();
    await transport.emitMessage({
      ...scope,
      id: "linux-lab-once",
      senderId: "lab-user",
      conversationType: "direct",
      receivedAt: new Date().toISOString(),
      replyReference: { requestId: "linux-lab-once" },
      parts: [{ type: "text", text: "credential-free Linux preflight" }],
    });
    const session = await store.getSession(scope);
    assert.ok(session);
    if (previousSession) assert.equal(session, previousSession);
    const finals = transport.deliveries.filter(
      (command) => command.type === "reply" && command.final,
    );
    assert.equal(finals.length, previousSession ? 0 : 1);
    assert.deepEqual(errors, []);
    const snapshot = await gateway.operationalSnapshot();
    assert.equal(snapshot.ready, true);
    assert.equal(
      snapshot.outbox.pending + snapshot.outbox.leased + snapshot.outbox.dead,
      0,
    );
    await observability.start();
    return {
      stop,
      port: observability.port,
      report: {
        event: "linux_lab_ready",
        realBot: false,
        realAgent: false,
        reusedSession: Boolean(previousSession),
        newFinals: finals.length,
        outbox: snapshot.outbox,
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.platform !== "linux")
    throw new Error("Linux lab service requires Linux");
  try {
    const lab = await startLinuxLab(
      "/var/lib/wecom-agent-gateway/linux-lab.db",
    );
    console.log(JSON.stringify(lab.report));
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => {
        void lab.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
  } catch {
    console.error(
      JSON.stringify({
        event: "linux_lab_failed",
        realBot: false,
        realAgent: false,
      }),
    );
    process.exitCode = 1;
  }
}
