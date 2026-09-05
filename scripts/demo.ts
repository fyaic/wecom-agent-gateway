import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AllowlistPolicy,
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "../packages/channel-core/src/index.js";
import { SqliteGatewayStore } from "../packages/storage-sqlite/src/index.js";
import { LoopbackTransport } from "../packages/transport-loopback/src/index.js";
import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";
import type { OutboundCommand } from "../packages/runtime-contract/src/index.js";

/** Runs the actual Core, SQLite and external-module loader, with local echo peers. */
export async function runDemo(
  log: (line: string) => void = console.log,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "wecom-onboarding-demo-"));
  const errors: Error[] = [];
  const scope = {
    accountId: "demo-bot",
    conversationId: "demo-chat",
    adapterId: "example:v1",
  };
  const env = {
    GATEWAY_ADAPTER: "external",
    GATEWAY_EXTERNAL_ADAPTER_MODULE: "./examples/adapter-template/src/index.ts",
    GATEWAY_EXTERNAL_ADAPTER_BASE_DIRECTORY: join(import.meta.dirname, ".."),
  };
  let gateway: WeComAgentGateway | undefined;
  let store: SqliteGatewayStore | undefined;
  let checks = 0;
  const pass = (label: string) => {
    checks++;
    log(`✓ ${label}`);
  };
  const start = async () => {
    const adapter = await createConfiguredAdapter({ env, tools: [] });
    store = new SqliteGatewayStore(join(directory, "gateway.db"));
    const transport = new LoopbackTransport();
    gateway = new WeComAgentGateway({
      adapters: [adapter],
      transport,
      store,
      router: new StaticRuntimeRouter(adapter.id),
      policy: new AllowlistPolicy({ allowedDirectSenders: ["demo-user"] }),
      onRuntimeError: (error) => errors.push(error),
      onInfrastructureError: (event) => errors.push(event.error),
    });
    await gateway.start();
    return transport;
  };
  const send = async (
    transport: LoopbackTransport,
    id: string,
    text: string,
    senderId = "demo-user",
  ) => {
    await transport.emitMessage({
      ...scope,
      id,
      senderId,
      conversationType: "direct",
      replyReference: { requestId: id },
      receivedAt: new Date().toISOString(),
      parts: [{ type: "text", text }],
    });
  };
  const finals = (commands: OutboundCommand[]) =>
    commands.filter((command) => command.type === "reply" && command.final);
  log(
    "Local demo / 本地演示 — deterministic Echo, not an AI model or a real WeCom connection.",
  );
  try {
    let transport = await start();
    await send(transport, "first", "hello");
    assert.equal(finals(transport.deliveries).length, 1);
    const final = finals(transport.deliveries)[0]!;
    assert.equal(final.type === "reply" && final.text, "echo: hello");
    const session = await store!.getSession(scope);
    assert.ok(session);
    log(`You: hello\nEcho: ${final.type === "reply" ? final.text : ""}`);
    pass("Inbound → external Adapter → mutable reply → durable final");
    const delivered = transport.deliveries.length;
    await send(transport, "first", "hello");
    assert.equal(transport.deliveries.length, delivered);
    pass("Duplicate inbound does not create a second reply");
    await send(transport, "denied", "hello", "unregistered-user");
    assert.equal(transport.deliveries.length, delivered);
    pass("Unregistered sender is rejected");
    await gateway!.stop();
    store!.close();
    store = undefined;
    gateway = undefined;
    transport = await start();
    await send(transport, "second", "still here");
    assert.equal(await store!.getSession(scope), session);
    assert.equal(finals(transport.deliveries).length, 1);
    pass("Recreated Gateway and SQLite store reuse the same session reference");
    assert.equal(
      await gateway!.sendProactiveText({
        ...scope,
        text: "Your task is complete.",
      }),
      "delivered",
    );
    assert.ok(
      transport.deliveries.some(
        (command) =>
          command.type === "proactive" &&
          command.text === "Your task is complete.",
      ),
    );
    pass("Proactive notification uses the same durable delivery path");
    const stats = await store!.getDeliveryOutboxStats();
    assert.equal(stats.pending + stats.leased + stats.dead, 0);
    assert.deepEqual(errors, []);
    pass("Outbox drained; no runtime or infrastructure errors");
    log(
      `${checks}/6 checks passed. Next: pnpm onboard --adapter <your-agent>\nNo Bot credentials, model calls, .env reads or production data were used.`,
    );
  } finally {
    try {
      await gateway?.stop();
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runDemo();
