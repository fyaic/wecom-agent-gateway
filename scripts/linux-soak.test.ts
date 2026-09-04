import { describe, expect, it } from "vitest";
import {
  evaluateSoak,
  parseOutboxMetrics,
  parseSoakConfiguration,
  type SoakConfiguration,
  type SoakSample,
} from "./linux-soak.js";

const baseConfig: SoakConfiguration = {
  durationMs: 24 * 60 * 60 * 1_000,
  intervalMs: 30_000,
  requestTimeoutMs: 3_000,
  service: "wecom-agent-gateway.service",
  observabilityPort: 9_464,
  statePath: "/var/lib/wecom-agent-gateway/gateway.db",
  spoolPath: "/var/lib/wecom-agent-gateway/media-spool",
  outputPath: "/tmp/report.json",
  minimumFreeBytes: 512 * 1_048_576,
  expectNetworkOutage: false,
  nonCertifying: false,
};

describe("Linux/systemd soak gate", () => {
  it("refuses to certify a run shorter than 24 hours", () => {
    expect(() => parseSoakConfiguration(["--duration-hours=23"], {})).toThrow(
      "at least 24 hours",
    );
    expect(
      parseSoakConfiguration(["--duration-hours=0.001", "--non-certifying"], {})
        .nonCertifying,
    ).toBe(true);
  });

  it("parses only bounded aggregate outbox metrics", () => {
    expect(
      parseOutboxMetrics(
        [
          'wecom_gateway_outbox_entries{state="pending"} 2',
          'wecom_gateway_outbox_entries{state="dead"} 0',
          'wecom_gateway_delivery_events_total{message_id="secret"} 9',
        ].join("\n"),
      ),
    ).toEqual({ pending: 2, dead: 0 });
  });

  it("passes a healthy 24-hour aggregate without exposing identifiers", () => {
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      baseConfig,
      [sample(started), sample(started + baseConfig.durationMs)],
      started,
      started + baseConfig.durationMs,
      { entries: 12, invocations: 1 },
    );
    expect(report.passed).toBe(process.platform === "linux");
    expect(report.certifying).toBe(true);
    expect(JSON.stringify(report)).not.toContain("/var/lib");
    expect(report.durability.finalDead).toBe(0);
  });

  it("accepts an observed ready loss and recovery only when service stayed live", () => {
    const config = {
      ...baseConfig,
      expectNetworkOutage: true,
      nonCertifying: true,
    };
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const samples = [
      sample(started),
      sample(started + 30_000, { ready: false }),
      sample(started + 60_000),
    ];
    const report = evaluateSoak(config, samples, started, started + 60_000, {
      entries: 3,
      invocations: 1,
    });
    expect(report.networkOutage).toMatchObject({
      observedReadyLossWhileLive: true,
      observedRecovery: true,
      externallyAttested: false,
    });
    expect(report.checks.networkOutageObserved).toBe(true);
  });

  it("fails closed on dead letters, remaining spool, or low disk", () => {
    const config = { ...baseConfig, nonCertifying: true };
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      config,
      [
        sample(started, {
          outbox: { pending: 0, leased: 0, dead: 1 },
          spoolFiles: 1,
          freeBytes: 1,
        }),
      ],
      started,
      started + config.durationMs,
      { entries: 1, invocations: 1 },
    );
    expect(report.passed).toBe(false);
    expect(report.checks).toMatchObject({
      noDeadLetters: false,
      mediaSpoolDrained: false,
      diskWatermarkMaintained: false,
    });
  });

  it("fails an unplanned readiness interruption", () => {
    const config = { ...baseConfig, nonCertifying: true };
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      config,
      [sample(started, { ready: false }), sample(started + 30_000)],
      started,
      started + config.durationMs,
      { entries: 1, invocations: 1 },
    );
    expect(report.passed).toBe(false);
    expect(report.checks.readinessStayedUpUnlessExpectedOutage).toBe(false);
  });

  it("accepts an empty but readable journal for a quiet service", () => {
    const config = { ...baseConfig, nonCertifying: true };
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      config,
      [sample(started)],
      started,
      started + config.durationMs,
      { readable: true, entries: 0, invocations: 0 },
    );
    expect(report.checks.journalReadable).toBe(true);
  });
});

function sample(at: number, overrides: Partial<SoakSample> = {}): SoakSample {
  return {
    at: new Date(at).toISOString(),
    serviceActive: true,
    live: true,
    ready: true,
    mainPid: 100,
    restarts: 0,
    outbox: { pending: 0, leased: 0, dead: 0 },
    spoolFiles: 0,
    freeBytes: 2 * 1_073_741_824,
    ...overrides,
  };
}
