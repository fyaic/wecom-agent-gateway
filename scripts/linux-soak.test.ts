import { describe, expect, it } from "vitest";
import {
  evaluateSoak,
  parseOutboxMetrics,
  parseSoakConfiguration,
  runLinuxSoak,
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

  it("bounds probe timeout so it cannot excuse arbitrarily large observation gaps", () => {
    expect(() =>
      parseSoakConfiguration(["--timeout-seconds=86400"], {}),
    ).toThrow("30 seconds");
    expect(() =>
      parseSoakConfiguration(["--duration-hours=1e308"], {}),
    ).toThrow("duration-hours");
  });

  it("parses only bounded aggregate outbox metrics", () => {
    expect(
      parseOutboxMetrics(
        [
          metrics({ pending: 2 }),
          'wecom_gateway_delivery_events_total{message_id="secret"} 9',
        ].join("\n"),
      ),
    ).toEqual({ pending: 2, leased: 0, delivered: 0, dead: 0, superseded: 0 });
  });

  it.each([
    "",
    'wecom_gateway_outbox_entries{state="pending"} 0',
    metrics() + '\nwecom_gateway_outbox_entries{state="pending"} 0',
    metrics().replace('state="pending"} 0', 'state="pending"} -1'),
    metrics().replace('state="pending"} 0', 'state="pending"} 0.5'),
    metrics().replace('state="pending"} 0', 'state="pending"} NaN'),
    metrics().replace(
      'state="pending"} 0',
      'state="pending"} 9007199254740992',
    ),
    metrics().replace('state="pending"', 'state="unknown"'),
  ])(
    "rejects incomplete, ambiguous or invalid aggregate metrics (%#)",
    (body) => {
      expect(() => parseOutboxMetrics(body)).toThrow();
    },
  );

  it("passes a healthy 24-hour aggregate without exposing identifiers", () => {
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      baseConfig,
      Array.from(
        { length: baseConfig.durationMs / baseConfig.intervalMs + 1 },
        (_, index) => sample(started + index * baseConfig.intervalMs),
      ),
      started,
      started + baseConfig.durationMs,
      { entries: 12, invocations: 1 },
    );
    expect(report.passed).toBe(process.platform === "linux");
    expect(report.certifying).toBe(true);
    expect(report.schemaVersion).toBe(2);
    expect(JSON.stringify(report)).not.toContain("/var/lib");
    expect(JSON.stringify(report)).not.toContain(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(report.durability.finalDead).toBe(0);
  });

  it("accepts an observed ready loss and recovery only when service stayed live", () => {
    const config = {
      ...baseConfig,
      durationMs: 60_000,
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
    expect(report.passed).toBe(true);
    expect(report.health.longestReadyFailureMs).toBe(30_000);
  });

  it("fails closed on dead letters, remaining spool, or low disk", () => {
    const config = { ...baseConfig, nonCertifying: true };
    const started = Date.parse("2026-09-04T00:00:00.000Z");
    const report = evaluateSoak(
      config,
      [
        sample(started, {
          outbox: {
            pending: 0,
            leased: 0,
            delivered: 0,
            dead: 1,
            superseded: 0,
          },
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

  it("does not certify a 24-hour wall-clock jump with only two observations", () => {
    const report = evaluateSoak(
      { ...baseConfig, nonCertifying: true },
      [sample(0), sample(baseConfig.durationMs)],
      0,
      baseConfig.durationMs,
      { readable: true, entries: 0, invocations: 0 },
    );
    expect(report.checks.durationMet).toBe(true);
    expect(report.checks.samplingGapsBounded).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("requires a closing sample after the full duration rather than a final unobserved sleep", () => {
    const report = evaluateSoak(
      shortConfig(),
      [sample(0), sample(30_000)],
      0,
      60_000,
      journal(),
    );
    expect(report.checks.samplingWindowCovered).toBe(false);
    expect(report.passed).toBe(false);
  });

  it.each([
    [sample(0), sample(0), sample(60_000)],
    [sample(0), sample(30_000, { at: "invalid" }), sample(60_000)],
    [sample(0), sample(60_000), sample(30_000)],
  ])("rejects invalid or nonmonotonic sample timestamps (%#)", (...samples) => {
    expect(
      evaluateSoak(shortConfig(), samples, 0, 60_000, journal()).passed,
    ).toBe(false);
  });

  it.each([
    { mainPid: 200 },
    { restarts: 1 },
    { invocationId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ])(
    "fails a process generation change even when all probes are healthy (%#)",
    (change) => {
      const report = evaluateSoak(
        shortConfig(),
        [sample(0), sample(30_000, change), sample(60_000)],
        0,
        60_000,
        journal(),
      );
      expect(report.checks.processStayedSame).toBe(false);
      expect(report.passed).toBe(false);
    },
  );

  it("fails restarts visible only in journal and invalid process metadata", () => {
    const samples = [sample(0), sample(30_000), sample(60_000)];
    expect(
      evaluateSoak(shortConfig(), samples, 0, 60_000, {
        entries: 3,
        invocations: 2,
      }).checks.processStayedSame,
    ).toBe(false);
    samples[1] = sample(30_000, {
      mainPid: 0,
      invocationId: "",
      restarts: Number.NaN,
    });
    expect(
      evaluateSoak(shortConfig(), samples, 0, 60_000, journal()).checks
        .serviceSnapshotsValid,
    ).toBe(false);
  });

  it("fails if dead letters were observed then disappeared before the final sample", () => {
    const failed = sample(30_000);
    failed.outbox.dead = 1;
    const report = evaluateSoak(
      shortConfig(),
      [sample(0), failed, sample(60_000)],
      0,
      60_000,
      journal(),
    );
    expect(report.durability.finalDead).toBe(0);
    expect(report.checks.noDeadLetters).toBe(false);
  });

  it("does not report missing metrics as zero or drained", () => {
    const report = evaluateSoak(
      shortConfig(),
      [sample(0), sample(30_000), sample(60_000, { outbox: {} })],
      0,
      60_000,
      journal(),
    );
    expect(report.health.metricsFailures).toBe(1);
    expect(report.durability.finalPending).toBeNull();
    expect(report.durability.peakPending).toBeNull();
    expect(report.checks.finalOutboxDrained).toBe(false);
    expect(report.checks.metricsAvailableAndValid).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("collects a final real probe at the deadline in the fake-backed runner", async () => {
    const report = await runLinuxSoak(shortConfig(), dependencies());
    expect(report.samples).toBe(3);
    expect(report.observedDurationMs).toBe(60_000);
    expect(report.sampling.coversPlannedWindow).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.certifying).toBe(false);
  });

  it("allows bounded probe overhead but rejects an overslept observation gap", async () => {
    const healthy = await runLinuxSoak(
      shortConfig(),
      dependencies(undefined, 1_000),
    );
    expect(healthy.passed).toBe(true);
    expect(healthy.observedDurationMs).toBe(61_000);
    expect(healthy.sampling.maximumGapMs).toBe(31_000);
    const suspended = await runLinuxSoak(
      shortConfig(),
      dependencies(undefined, 0, 60_000),
    );
    expect(suspended.checks.durationMet).toBe(true);
    expect(suspended.checks.samplingGapsBounded).toBe(false);
    expect(suspended.passed).toBe(false);
  });

  it("rejects non-finite resource readings rather than interpreting them as healthy", () => {
    const report = evaluateSoak(
      shortConfig(),
      [sample(0), sample(30_000, { freeBytes: Infinity }), sample(60_000)],
      0,
      60_000,
      journal(),
    );
    expect(report.checks.resourceSnapshotsValid).toBe(false);
    expect(report.passed).toBe(false);
  });

  it.each(["unavailable", "malformed", "false-health"] as const)(
    "runner fails closed when probe is %s",
    async (failure) => {
      const report = await runLinuxSoak(shortConfig(), dependencies(failure));
      expect(report.passed).toBe(false);
      expect(JSON.stringify(report)).not.toContain("private");
      if (failure === "false-health") {
        expect(report.health.liveFailures).toBe(3);
        expect(report.health.readyFailures).toBe(3);
      } else {
        expect(report.health.metricsFailures).toBe(3);
        expect(report.durability.finalDead).toBeNull();
      }
    },
  );
});

function sample(at: number, overrides: Partial<SoakSample> = {}): SoakSample {
  return {
    at: new Date(at).toISOString(),
    serviceActive: true,
    live: true,
    ready: true,
    mainPid: 100,
    restarts: 0,
    invocationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    outbox: { pending: 0, leased: 0, delivered: 0, dead: 0, superseded: 0 },
    spoolFiles: 0,
    freeBytes: 2 * 1_073_741_824,
    ...overrides,
  };
}

function metrics(overrides: Record<string, number> = {}): string {
  return Object.entries({
    pending: 0,
    leased: 0,
    delivered: 0,
    dead: 0,
    superseded: 0,
    ...overrides,
  })
    .map(
      ([state, value]) =>
        `wecom_gateway_outbox_entries{state="${state}"} ${value}`,
    )
    .join("\n");
}

function shortConfig(): SoakConfiguration {
  return { ...baseConfig, durationMs: 60_000, nonCertifying: true };
}

function journal() {
  return { readable: true, entries: 0, invocations: 0 };
}

function dependencies(
  failure?: "unavailable" | "malformed" | "false-health",
  probeMs = 0,
  sleepOverheadMs = 0,
): Parameters<typeof runLinuxSoak>[1] {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms + sleepOverheadMs;
    },
    serviceSnapshot: async () => {
      now += probeMs;
      return {
        active: true,
        mainPid: 100,
        restarts: 0,
        invocationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
    },
    endpoint: async (path) => {
      if (path === "/metrics") {
        if (failure === "unavailable")
          throw new Error("private request details");
        return {
          ok: true,
          body:
            failure === "malformed" ? "private malformed content" : metrics(),
        };
      }
      return {
        ok: true,
        body: JSON.stringify({
          live: failure !== "false-health",
          ready: failure !== "false-health",
        }),
      };
    },
    spoolFiles: async () => 0,
    freeBytes: async () => 2 * 1_073_741_824,
    journalSummary: async () => journal(),
  };
}
