import { afterEach, describe, expect, it } from "vitest";
import type { GatewayOperationalSnapshot } from "@fyaic/wecom-channel-core";
import { GatewayMetrics, LocalObservabilityServer } from "../src/index.js";

const servers: LocalObservabilityServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
});

describe("local operational observability", () => {
  it("serves loopback liveness, readiness, and identifier-free metrics", async () => {
    let snapshot = operationalSnapshot(false);
    let live = true;
    const metrics = new GatewayMetrics();
    metrics.recordGatewayLifecycle({
      phase: "completed",
      conversationType: "direct",
      adapterId: "must-not-be-a-label",
      elapsedMs: 125,
      measuredFrom: "enqueued",
    });
    metrics.recordDelivery({
      phase: "delivered",
      commandType: "proactive",
      attempts: 1,
    });
    const server = new LocalObservabilityServer({
      host: "127.0.0.1",
      port: 0,
      metrics,
      snapshot: async () => snapshot,
      isLive: () => live,
    });
    servers.push(server);
    await server.start();
    const root = `http://127.0.0.1:${server.port}`;

    expect(await response(root, "/livez")).toMatchObject({ status: 200 });
    expect(await response(root, "/readyz")).toMatchObject({
      status: 503,
      body: '{"ready":false,"state":"starting"}\n',
    });

    snapshot = operationalSnapshot(true);
    const ready = await response(root, "/readyz");
    expect(ready).toMatchObject({ status: 200 });
    const rendered = await response(root, "/metrics");
    expect(rendered.status).toBe(200);
    expect(rendered.body).toContain("wecom_gateway_ready 1");
    expect(rendered.body).toContain(
      'wecom_gateway_delivery_events_total{command_type="proactive",phase="delivered"} 1',
    );
    expect(rendered.body).not.toContain("must-not-be-a-label");
    expect(rendered.body).not.toContain("private-account-id");
    expect(rendered.body).not.toContain("private-conversation-id");

    live = false;
    expect(await response(root, "/livez")).toMatchObject({ status: 503 });
  });

  it("rejects non-loopback binding and unknown routes", async () => {
    expect(
      () =>
        new LocalObservabilityServer({
          host: "0.0.0.0",
          metrics: new GatewayMetrics(),
          snapshot: async () => operationalSnapshot(true),
        }),
    ).toThrow("loopback");

    const server = new LocalObservabilityServer({
      port: 0,
      metrics: new GatewayMetrics(),
      snapshot: async () => operationalSnapshot(true),
    });
    servers.push(server);
    await server.start();
    expect(
      await response(`http://127.0.0.1:${server.port}`, "/private-id"),
    ).toMatchObject({ status: 404, body: "not found\n" });
  });

  it("returns a generic 503 when an operational snapshot times out", async () => {
    const errors: Error[] = [];
    const server = new LocalObservabilityServer({
      port: 0,
      metrics: new GatewayMetrics(),
      snapshotTimeoutMs: 10,
      snapshot: () => new Promise(() => undefined),
      onError: (error) => errors.push(error),
    });
    servers.push(server);
    await server.start();
    const result = await response(`http://127.0.0.1:${server.port}`, "/readyz");
    expect(result).toEqual({ status: 503, body: '{"ready":false}\n' });
    expect(errors).toHaveLength(1);
    expect(result.body).not.toContain("timed out");
  });
});

function operationalSnapshot(ready: boolean): GatewayOperationalSnapshot {
  return {
    state: ready ? "running" : "starting",
    ready,
    transportHealthy: ready,
    adapters: { total: 1, healthy: ready ? 1 : 0 },
    storeHealthy: true,
    work: {
      pendingInboundMessages: 0,
      activeRuns: 0,
      pendingApprovals: 0,
    },
    outbox: {
      pending: 0,
      leased: 0,
      delivered: 5,
      dead: 0,
      superseded: 0,
    },
  };
}

async function response(root: string, path: string) {
  const result = await fetch(`${root}${path}`);
  return { status: result.status, body: await result.text() };
}
