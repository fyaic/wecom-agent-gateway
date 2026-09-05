import { execFile } from "node:child_process";
import { mkdir, readdir, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const CERTIFYING_MINIMUM_MS = 24 * 60 * 60 * 1_000;
const OUTBOX_STATES = ["pending", "leased", "delivered", "dead", "superseded"];

export interface SoakConfiguration {
  durationMs: number;
  intervalMs: number;
  requestTimeoutMs: number;
  service: string;
  observabilityPort: number;
  statePath: string;
  spoolPath: string;
  outputPath: string;
  minimumFreeBytes: number;
  expectNetworkOutage: boolean;
  nonCertifying: boolean;
}

interface ServiceSnapshot {
  active: boolean;
  mainPid: number;
  restarts: number;
  invocationId: string;
}

export interface SoakSample {
  at: string;
  serviceActive: boolean;
  live: boolean;
  ready: boolean;
  mainPid: number;
  restarts: number;
  // Used only to compare process generations; never included in the report.
  invocationId: string;
  outbox: Record<string, number>;
  spoolFiles: number;
  freeBytes: number;
}

export interface SoakReport {
  schemaVersion: 2;
  event: "linux_systemd_soak";
  certifying: boolean;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  plannedDurationMs: number;
  observedDurationMs: number;
  intervalMs: number;
  samples: number;
  service: {
    inactiveSamples: number;
    pidChanges: number;
    restartDelta: number;
    invocationChanges: number;
    journalEntries: number;
    journalInvocations: number;
  };
  health: {
    liveFailures: number;
    readyFailures: number;
    longestReadyFailureMs: number;
    recoveredAfterReadyFailure: boolean;
    metricsFailures: number;
  };
  sampling: {
    maximumGapMs: number;
    allowedGapMs: number;
    coversPlannedWindow: boolean;
  };
  durability: {
    peakPending: number | null;
    peakLeased: number | null;
    finalPending: number | null;
    finalLeased: number | null;
    finalDead: number | null;
    finalSpoolFiles: number;
  };
  resources: {
    minimumFreeBytes: number;
    requiredFreeBytes: number;
  };
  networkOutage: {
    expected: boolean;
    observedReadyLossWhileLive: boolean;
    observedRecovery: boolean;
    externallyAttested: false;
  };
  checks: Record<string, boolean>;
  notes: string[];
}

interface SoakDependencies {
  now(): number;
  sleep(ms: number): Promise<void>;
  serviceSnapshot(service: string): Promise<ServiceSnapshot>;
  endpoint(
    path: "/livez" | "/readyz" | "/metrics",
    config: SoakConfiguration,
  ): Promise<{
    ok: boolean;
    body: string;
  }>;
  spoolFiles(path: string): Promise<number>;
  freeBytes(path: string): Promise<number>;
  journalSummary(
    service: string,
    sinceMs: number,
  ): Promise<{
    readable: boolean;
    entries: number;
    invocations: number;
  }>;
}

export async function runLinuxSoak(
  config: SoakConfiguration,
  dependencies: SoakDependencies = realDependencies,
): Promise<SoakReport> {
  const started = dependencies.now();
  const samples: SoakSample[] = [];
  while (true) {
    samples.push(await collectSample(config, dependencies));
    const remaining = started + config.durationMs - dependencies.now();
    if (remaining <= 0) break;
    await dependencies.sleep(Math.min(config.intervalMs, remaining));
  }

  const finished = dependencies.now();
  const journal = await dependencies.journalSummary(config.service, started);
  return evaluateSoak(config, samples, started, finished, journal);
}

export function evaluateSoak(
  config: SoakConfiguration,
  samples: SoakSample[],
  startedMs: number,
  finishedMs: number,
  journal: { readable?: boolean; entries: number; invocations: number },
): SoakReport {
  if (samples.length === 0)
    throw new Error("Soak requires at least one sample");
  const certifying =
    !config.nonCertifying && config.durationMs >= CERTIFYING_MINIMUM_MS;
  const readyFailures = samples.filter((sample) => !sample.ready).length;
  const liveFailures = samples.filter((sample) => !sample.live).length;
  const inactiveSamples = samples.filter(
    (sample) => !sample.serviceActive,
  ).length;
  const readyLossWhileLive = samples.some(
    (sample) => sample.serviceActive && sample.live && !sample.ready,
  );
  const firstReadyLoss = samples.findIndex(
    (sample) => sample.serviceActive && sample.live && !sample.ready,
  );
  const recoveredAfterReadyFailure =
    firstReadyLoss >= 0 &&
    samples.slice(firstReadyLoss + 1).some((sample) => sample.ready);
  const final = samples.at(-1)!;
  const sampleTimes = samples.map((sample) => Date.parse(sample.at));
  // Permit bounded probe/scheduler overhead, but never count an unobserved
  // sleep/suspend interval as evidence of a healthy service.
  const probeAllowanceMs = Math.min(
    30_000,
    Math.max(10_000, config.requestTimeoutMs),
  );
  const allowedGapMs = config.intervalMs + probeAllowanceMs;
  const gaps = sampleTimes
    .slice(1)
    .map((time, index) => time - sampleTimes[index]!);
  const maximumGapMs = Math.max(0, ...gaps);
  const timestampsValid =
    Number.isFinite(startedMs) &&
    Number.isFinite(finishedMs) &&
    sampleTimes.every(
      (time) =>
        Number.isFinite(time) && time >= startedMs && time <= finishedMs,
    ) &&
    gaps.every((gap) => gap > 0);
  const coversPlannedWindow =
    timestampsValid &&
    samples.length >= 2 &&
    sampleTimes[0]! - startedMs <= probeAllowanceMs &&
    sampleTimes.at(-1)! >= startedMs + config.durationMs &&
    finishedMs - sampleTimes.at(-1)! <= probeAllowanceMs;
  const metricsFailures = samples.filter(
    (sample) => !validOutbox(sample.outbox),
  ).length;
  const invocationChanges = samples
    .slice(1)
    .filter(
      (sample, index) => sample.invocationId !== samples[index]!.invocationId,
    ).length;
  const pidChanges = samples.slice(1).filter((sample, index) => {
    const previous = samples[index]!;
    return (
      sample.mainPid > 0 &&
      previous.mainPid > 0 &&
      sample.mainPid !== previous.mainPid
    );
  }).length;
  const restartDelta = Math.max(
    0,
    Math.max(...samples.map((sample) => sample.restarts)) -
      samples[0]!.restarts,
  );
  const minimumFreeBytes = Math.min(
    ...samples.map((sample) => sample.freeBytes),
  );
  const checks: Record<string, boolean> = {
    linuxPlatform: process.platform === "linux" || config.nonCertifying,
    durationMet: finishedMs - startedMs >= config.durationMs,
    certifyingDuration: certifying || config.nonCertifying,
    samplingWindowCovered: coversPlannedWindow,
    samplingGapsBounded: timestampsValid && maximumGapMs <= allowedGapMs,
    serviceSnapshotsValid: samples.every(
      (sample) =>
        Number.isSafeInteger(sample.mainPid) &&
        sample.mainPid > 0 &&
        Number.isSafeInteger(sample.restarts) &&
        sample.restarts >= 0 &&
        /^[a-f0-9]{32}$/.test(sample.invocationId),
    ),
    processStayedSame:
      pidChanges === 0 &&
      invocationChanges === 0 &&
      samples.every((sample) => sample.restarts === samples[0]!.restarts) &&
      journal.invocations <= 1,
    metricsAvailableAndValid: metricsFailures === 0,
    resourceSnapshotsValid: samples.every(
      (sample) =>
        Number.isSafeInteger(sample.spoolFiles) &&
        sample.spoolFiles >= 0 &&
        Number.isSafeInteger(sample.freeBytes) &&
        sample.freeBytes >= 0,
    ),
    serviceStayedActive: inactiveSamples === 0,
    livenessStayedUp: liveFailures === 0,
    readinessStayedUpUnlessExpectedOutage:
      config.expectNetworkOutage || readyFailures === 0,
    finalReady: final.ready,
    finalOutboxDrained:
      count(final.outbox, "pending") === 0 &&
      count(final.outbox, "leased") === 0,
    noDeadLetters: samples.every(
      (sample) => count(sample.outbox, "dead") === 0,
    ),
    mediaSpoolDrained: final.spoolFiles === 0,
    diskWatermarkMaintained: minimumFreeBytes >= config.minimumFreeBytes,
    journalReadable: journal.readable ?? journal.entries > 0,
    journalSummaryValid:
      Number.isSafeInteger(journal.entries) &&
      journal.entries >= 0 &&
      Number.isSafeInteger(journal.invocations) &&
      journal.invocations >= 0 &&
      journal.invocations <= journal.entries,
    networkOutageObserved:
      !config.expectNetworkOutage ||
      (readyLossWhileLive && recoveredAfterReadyFailure),
  };
  const notes = [
    "The report contains aggregate health and durability evidence only; it excludes messages, conversation identifiers, credentials, paths, and journal contents.",
    "Network-outage observation proves ready loss and recovery while the process stayed live; physical NIC/route/DNS disruption still requires an external operator attestation.",
    "Health evidence is sampled, not continuous; bounded sample gaps do not prove that no shorter interruption occurred. Outbox aggregates do not prove that any real user traffic was exercised.",
  ];
  if (config.nonCertifying) {
    notes.push(
      "This was an explicitly non-certifying short run and cannot satisfy the 24-hour Linux/systemd release gate.",
    );
  }
  return {
    schemaVersion: 2,
    event: "linux_systemd_soak",
    certifying,
    passed: Object.values(checks).every(Boolean),
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    plannedDurationMs: config.durationMs,
    observedDurationMs: finishedMs - startedMs,
    intervalMs: config.intervalMs,
    samples: samples.length,
    service: {
      inactiveSamples,
      pidChanges,
      restartDelta,
      invocationChanges,
      journalEntries: journal.entries,
      journalInvocations: journal.invocations,
    },
    health: {
      liveFailures,
      readyFailures,
      longestReadyFailureMs: longestFailure(samples, finishedMs),
      recoveredAfterReadyFailure,
      metricsFailures,
    },
    sampling: { maximumGapMs, allowedGapMs, coversPlannedWindow },
    durability: {
      peakPending: peak(samples, "pending"),
      peakLeased: peak(samples, "leased"),
      finalPending: reportedCount(final.outbox, "pending"),
      finalLeased: reportedCount(final.outbox, "leased"),
      finalDead: reportedCount(final.outbox, "dead"),
      finalSpoolFiles: final.spoolFiles,
    },
    resources: { minimumFreeBytes, requiredFreeBytes: config.minimumFreeBytes },
    networkOutage: {
      expected: config.expectNetworkOutage,
      observedReadyLossWhileLive: readyLossWhileLive,
      observedRecovery: recoveredAfterReadyFailure,
      externallyAttested: false,
    },
    checks,
    notes,
  };
}

export function parseSoakConfiguration(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): SoakConfiguration {
  const nonCertifying = argv.includes("--non-certifying");
  const durationHours = numericArgument(argv, "duration-hours", 24);
  const durationMs = durationHours * 60 * 60 * 1_000;
  if (!Number.isFinite(durationMs) || durationMs > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid --duration-hours");
  }
  if (!nonCertifying && durationHours < 24) {
    throw new Error("Certifying Linux soak duration must be at least 24 hours");
  }
  const intervalSeconds = numericArgument(argv, "interval-seconds", 30);
  if (intervalSeconds < 5 || intervalSeconds > 3_600) {
    throw new Error("Soak interval must be between 5 and 3600 seconds");
  }
  const timeoutSeconds = numericArgument(argv, "timeout-seconds", 3);
  if (timeoutSeconds > 30) {
    throw new Error("Soak request timeout must not exceed 30 seconds");
  }
  const service = stringArgument(
    argv,
    "service",
    "wecom-agent-gateway.service",
  );
  if (!/^[a-zA-Z0-9@_.-]+\.service$/.test(service)) {
    throw new Error("Invalid systemd service name");
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return {
    durationMs,
    intervalMs: intervalSeconds * 1_000,
    requestTimeoutMs: timeoutSeconds * 1_000,
    service,
    observabilityPort: positiveInteger(env.GATEWAY_OBSERVABILITY_PORT, 9_464),
    statePath: resolve(env.GATEWAY_DATABASE_PATH ?? "data/gateway.db"),
    spoolPath: resolve(env.GATEWAY_MEDIA_SPOOL_ROOT ?? "data/media-spool"),
    outputPath: resolve(
      stringArgument(
        argv,
        "output",
        `data/evidence/linux-systemd-soak-${timestamp}.json`,
      ),
    ),
    minimumFreeBytes:
      numericArgument(argv, "minimum-free-mib", 512) * 1_048_576,
    expectNetworkOutage: argv.includes("--expect-network-outage"),
    nonCertifying,
  };
}

async function collectSample(
  config: SoakConfiguration,
  dependencies: SoakDependencies,
): Promise<SoakSample> {
  const [service, live, ready, metrics, spoolFiles, freeBytes] =
    await Promise.all([
      dependencies.serviceSnapshot(config.service).catch(() => ({
        active: false,
        mainPid: 0,
        restarts: 0,
        invocationId: "",
      })),
      dependencies
        .endpoint("/livez", config)
        .catch(() => ({ ok: false, body: "" })),
      dependencies
        .endpoint("/readyz", config)
        .catch(() => ({ ok: false, body: "" })),
      dependencies
        .endpoint("/metrics", config)
        .catch(() => ({ ok: false, body: "" })),
      dependencies
        .spoolFiles(config.spoolPath)
        .catch(() => Number.MAX_SAFE_INTEGER),
      dependencies.freeBytes(config.statePath).catch(() => 0),
    ]);
  return {
    at: new Date(dependencies.now()).toISOString(),
    serviceActive: service.active,
    live: live.ok && healthFlag(live.body, "live"),
    ready: ready.ok && healthFlag(ready.body, "ready"),
    mainPid: service.mainPid,
    restarts: service.restarts,
    invocationId: service.invocationId,
    outbox: metrics.ok ? safeOutboxMetrics(metrics.body) : {},
    spoolFiles,
    freeBytes,
  };
}

export function parseOutboxMetrics(body: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of body.split("\n")) {
    if (!line.startsWith("wecom_gateway_outbox_entries")) continue;
    const match =
      /^wecom_gateway_outbox_entries\{state="([a-z_]+)"\} ([0-9]+)$/.exec(line);
    if (!match || !OUTBOX_STATES.includes(match[1]!) || match[1]! in result) {
      throw new Error("Invalid aggregate outbox metrics");
    }
    result[match[1]!] = Number(match[2]);
  }
  if (!validOutbox(result))
    throw new Error("Incomplete or invalid aggregate outbox metrics");
  return result;
}

function safeOutboxMetrics(body: string): Record<string, number> {
  try {
    return parseOutboxMetrics(body);
  } catch {
    return {};
  }
}

function validOutbox(outbox: Record<string, number>): boolean {
  return OUTBOX_STATES.every(
    (state) => Number.isSafeInteger(outbox[state]) && outbox[state]! >= 0,
  );
}

function healthFlag(body: string, flag: "live" | "ready"): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return (
      typeof value === "object" &&
      value !== null &&
      flag in value &&
      (value as Record<string, unknown>)[flag] === true
    );
  } catch {
    return false;
  }
}

const realDependencies: SoakDependencies = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  async serviceSnapshot(service) {
    const { stdout } = await execFileAsync(
      "systemctl",
      [
        "show",
        service,
        "--property=ActiveState,MainPID,NRestarts,InvocationID",
        "--no-pager",
      ],
      { timeout: 10_000 },
    );
    const values = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    return {
      active: values.ActiveState === "active",
      mainPid: Number(values.MainPID ?? 0),
      restarts: Number(values.NRestarts ?? 0),
      invocationId: values.InvocationID ?? "",
    };
  },
  async endpoint(path, config) {
    const response = await fetch(
      `http://127.0.0.1:${config.observabilityPort}${path}`,
      {
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        redirect: "error",
      },
    );
    return { ok: response.ok, body: await response.text() };
  },
  async spoolFiles(path) {
    let total = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(resolve(directory, entry.name));
        else if (entry.isFile()) total += 1;
      }
    };
    try {
      await walk(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return total;
  },
  async freeBytes(path) {
    const statistics = await statfs(dirname(path));
    return statistics.bavail * statistics.bsize;
  },
  async journalSummary(service, sinceMs) {
    const { stdout } = await execFileAsync(
      "journalctl",
      [
        `--unit=${service}`,
        `--since=@${Math.floor(sinceMs / 1_000)}`,
        "--output=json",
        "--output-fields=_SYSTEMD_INVOCATION_ID,__REALTIME_TIMESTAMP",
        "--no-pager",
      ],
      { maxBuffer: 32 * 1_024 * 1_024, timeout: 30_000 },
    );
    const invocations = new Set<string>();
    let entries = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as { _SYSTEMD_INVOCATION_ID?: string };
      entries += 1;
      if (value._SYSTEMD_INVOCATION_ID)
        invocations.add(value._SYSTEMD_INVOCATION_ID);
    }
    return { readable: true, entries, invocations: invocations.size };
  },
};

function count(outbox: Record<string, number>, state: string): number {
  return outbox[state] ?? Number.NaN;
}

function reportedCount(
  outbox: Record<string, number>,
  state: string,
): number | null {
  return validOutbox(outbox) ? count(outbox, state) : null;
}

function peak(samples: SoakSample[], state: string): number | null {
  return samples.every((sample) => validOutbox(sample.outbox))
    ? Math.max(...samples.map((sample) => count(sample.outbox, state)))
    : null;
}

function longestFailure(samples: SoakSample[], finishedMs: number): number {
  let longest = 0;
  let started: number | undefined;
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (!sample.ready) started ??= at;
    if (started !== undefined) longest = Math.max(longest, at - started);
    if (sample.ready) started = undefined;
  }
  if (started !== undefined) longest = Math.max(longest, finishedMs - started);
  return longest;
}

function numericArgument(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const value = stringArgument(argv, name, String(fallback));
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Invalid --${name}`);
  return parsed;
}

function stringArgument(
  argv: string[],
  name: string,
  fallback: string,
): string {
  const prefix = `--${name}=`;
  return (
    argv
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) ?? fallback
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Observability port must be a positive integer");
  }
  return parsed;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("Linux/systemd soak must run on a Linux host");
  }
  const config = parseSoakConfiguration(process.argv.slice(2));
  const report = await runLinuxSoak(config);
  await mkdir(dirname(config.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      schemaVersion: report.schemaVersion,
      event: report.event,
      certifying: report.certifying,
      passed: report.passed,
      samples: report.samples,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
