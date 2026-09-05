import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayMetrics,
  LocalObservabilityServer,
} from "../packages/observability-local/src/index.js";
import { inspectGatewayStatus, parseGatewayMetrics } from "./gateway-status.js";

const snapshot = () => ({
  state: "running" as const,
  ready: true,
  transportHealthy: true,
  storeHealthy: true,
  adapters: { total: 1, healthy: 1 },
  work: { pendingInboundMessages: 0, activeRuns: 0, pendingApprovals: 0 },
  outbox: { pending: 0, leased: 0, delivered: 3, dead: 0, superseded: 0 },
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop()));
});
const render = () => new GatewayMetrics().render(snapshot());

async function listen(server: Server) {
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local port");
  return {
    GATEWAY_OBSERVABILITY_ENABLED: "true",
    GATEWAY_OBSERVABILITY_PORT: String(address.port),
  };
}

describe("read-only gateway status", () => {
  it("reads the actual local metrics server and distinguishes failed delivery from readiness", async () => {
    const current = snapshot();
    const server = new LocalObservabilityServer({
      port: 0,
      metrics: new GatewayMetrics(),
      snapshot: async () => current,
    });
    cleanup.push(() => server.stop());
    await server.start();
    const env = {
      GATEWAY_OBSERVABILITY_ENABLED: "true",
      GATEWAY_OBSERVABILITY_PORT: String(server.port),
    };
    expect(await inspectGatewayStatus(env)).toMatchObject({
      status: "healthy",
      findings: [],
    });
    current.work.activeRuns = 1;
    current.work.pendingApprovals = 1;
    current.outbox.pending = 1;
    expect(await inspectGatewayStatus(env)).toMatchObject({
      status: "busy",
      findings: ["deliveries-pending", "work-active", "approval-pending"],
    });
    current.outbox.dead = 1;
    expect(await inspectGatewayStatus(env)).toMatchObject({
      status: "degraded",
      snapshot: { ready: true },
      findings: expect.arrayContaining(["outbox-dead"]),
    });
  });

  it("classifies component failures without inferring a model or network root cause", () => {
    const current = {
      ...snapshot(),
      ready: false,
      transportHealthy: false,
      storeHealthy: false,
      adapters: { total: 1, healthy: 0 },
    };
    expect(
      parseGatewayMetrics(new GatewayMetrics().render(current)),
    ).toMatchObject({
      status: "degraded",
      findings: [
        "gateway-not-ready",
        "transport-unhealthy",
        "store-unhealthy",
        "adapter-unhealthy",
      ],
    });
  });

  it("never copies unknown labels, comments or payloads into reports", () => {
    const output = parseGatewayMetrics(
      render() +
        '\n# private-token\nunknown{user="private-person"} 1\nprivate-chat-content\n',
    );
    expect(output.status).toBe("healthy");
    expect(JSON.stringify(output)).not.toContain("private");
  });

  it.each([
    (text: string) =>
      text.replace("wecom_gateway_ready 1", "wecom_gateway_ready NaN"),
    (text: string) =>
      text.replace("wecom_gateway_ready 1", "wecom_gateway_ready -1"),
    (text: string) =>
      text.replace("wecom_gateway_ready 1", "wecom_gateway_ready 2"),
    (text: string) =>
      text.replace("wecom_gateway_ready 1", "wecom_gateway_ready 0.5"),
    (text: string) => text + "\nwecom_gateway_ready 1\n",
    (text: string) => text.replace("wecom_gateway_ready 1", ""),
    (text: string) =>
      text.replace(
        "wecom_gateway_transport_healthy 1",
        "wecom_gateway_transport_healthy 0",
      ),
    (text: string) =>
      text.replace(
        'wecom_gateway_adapters{state="healthy"} 1',
        'wecom_gateway_adapters{state="healthy"} 2',
      ),
  ])(
    "rejects malformed, incomplete or contradictory expected samples",
    (mutate) => {
      expect(parseGatewayMetrics(mutate(render())).status).toBe(
        "invalid-response",
      );
    },
  );

  it("does not probe disabled or non-loopback configurations", async () => {
    expect((await inspectGatewayStatus({})).status).toBe("disabled");
    for (const env of [
      { GATEWAY_OBSERVABILITY_ENABLED: "yes" },
      {
        GATEWAY_OBSERVABILITY_ENABLED: "true",
        GATEWAY_OBSERVABILITY_HOST: "example.com",
      },
      {
        GATEWAY_OBSERVABILITY_ENABLED: "true",
        GATEWAY_OBSERVABILITY_PORT: "0",
      },
    ])
      expect((await inspectGatewayStatus(env)).status).toBe(
        "invalid-configuration",
      );
  });

  it("rejects redirects and does not disclose the redirect location", async () => {
    const env = await listen(
      createServer((_req, res) => {
        res.writeHead(302, { Location: "https://example.com/private-token" });
        res.end();
      }),
    );
    const result = await inspectGatewayStatus(env);
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("bounds response size and timeout, and sanitizes HTTP errors", async () => {
    const large = await listen(
      createServer((_req, res) => res.end("x".repeat(65_537))),
    );
    expect((await inspectGatewayStatus(large)).status).toBe("invalid-response");
    const hanging = await listen(createServer(() => undefined));
    expect((await inspectGatewayStatus(hanging, 20)).status).toBe(
      "unavailable",
    );
    const failed = await listen(
      createServer((_req, res) => {
        res.writeHead(503);
        res.end("private-error");
      }),
    );
    expect(await inspectGatewayStatus(failed)).toEqual({
      schemaVersion: 1,
      event: "gateway_status",
      status: "unavailable",
      findings: ["metrics-unavailable"],
    });
  });
});
