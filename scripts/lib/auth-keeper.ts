import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type KeeperMode = "doctor" | "inspect" | "renew" | "pre-renew";
/** Aggregate page evidence only. Never includes capability names, IDs or URLs. */
export interface KeeperObservation {
  observedAtMs: number;
  earliestExpiryMs: number | null;
  expiredCount: number;
  pendingRecovery: boolean;
}
export interface KeeperReport {
  schemaVersion: 1;
  event: "auth_keeper";
  mode: KeeperMode;
  ok: boolean;
  status: string;
  scope: "optional-cli-capabilities";
  targetRowCount: number;
  identity: "not-verified" | "configuration-matched" | "page-verified";
  businessApi: "not-verified";
  cliCredentialIdentity: "not-verified";
  transport: "not-checked";
  observation?: KeeperObservation;
}

export interface KeeperProcessResult {
  exitCode: number | null;
  stdout: string;
  failure?: "timeout" | "process-failed";
}
export interface KeeperInvocation {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}
export type KeeperRunner = (
  invocation: KeeperInvocation,
) => Promise<KeeperProcessResult>;

export function keeperChildEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "USER",
      "LOGNAME",
      "__CF_USER_TEXT_ENCODING",
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])),
  );
}

/** Never forward child stderr/error messages, paths, IDs, links or raw JSON. */
export const runKeeperProcess: KeeperRunner = (invocation) =>
  new Promise((done) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
        encoding: "utf8",
        // The sidecar needs the desktop user's system context, not Bot secrets,
        // model API keys, NODE_OPTIONS, PYTHONPATH or unrelated service tokens.
        env: keeperChildEnvironment(process.env),
      },
      (error, stdout) => {
        if (error) {
          done({
            exitCode: typeof error.code === "number" ? error.code : null,
            stdout,
            failure: error.killed ? "timeout" : "process-failed",
          });
        } else done({ exitCode: 0, stdout });
      },
    );
  });

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function configuredString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !value.startsWith("<")
  );
}

/** Resolve existing ancestors too: a not-yet-created file can live below a
 * symlinked directory. Comparing only path strings would allow a state write
 * to replace the original configuration after it has been snapshotted. */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

/** Keeper emits local ISO datetimes, not locale-specific date strings. Reject
 * normalization (e.g. February 30) instead of scheduling from invented dates. */
function keeperExpiryMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(value);
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() + 1 !== Number(month) ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute) ||
    date.getSeconds() !== Number(second)
  )
    return undefined;
  return date.getTime();
}

function pageObservation(
  payload: Record<string, unknown>,
  targetRows: string[],
  observedAtMs: number,
): KeeperObservation | undefined {
  const observed = payload.rows;
  if (
    !object(observed) ||
    typeof payload.pending_recovery !== "boolean" ||
    Object.keys(observed).length !== targetRows.length
  )
    return undefined;
  let expiredCount = 0;
  let earliestExpiryMs: number | null = null;
  for (const row of targetRows) {
    if (!Object.hasOwn(observed, row)) return undefined;
    const item = observed[row];
    if (!object(item)) return undefined;
    const expiry = item.expiry === null ? null : keeperExpiryMs(item.expiry);
    if (expiry === undefined) return undefined;
    if (item.status === "authorized") {
      if (expiry === null || expiry <= observedAtMs) return undefined;
    } else if (item.status === "expired") {
      if (expiry !== null && expiry > observedAtMs) return undefined;
      expiredCount += 1;
    } else return undefined;
    if (expiry !== null)
      earliestExpiryMs =
        earliestExpiryMs === null ? expiry : Math.min(earliestExpiryMs, expiry);
  }
  return {
    observedAtMs,
    earliestExpiryMs,
    expiredCount,
    pendingRecovery: payload.pending_recovery,
  };
}

/** Standalone operator helper. No Gateway runtime, credentials or business API calls. */
export async function inspectAuthKeeper(
  options: {
    mode?: KeeperMode;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    run?: KeeperRunner;
    withinHours?: number;
    existingWindowOnly?: boolean;
    /** Optional immutable provider binding. Both values must be supplied. */
    expectedConfigDigest?: string;
    expectedConfigPath?: string;
  } = {},
): Promise<KeeperReport> {
  const mode = options.mode ?? "doctor";
  const env = options.env ?? process.env;
  const result: KeeperReport = {
    schemaVersion: 1,
    event: "auth_keeper",
    mode,
    ok: false,
    status: "invalid-configuration",
    scope: "optional-cli-capabilities",
    targetRowCount: 0,
    identity: "not-verified",
    businessApi: "not-verified",
    cliCredentialIdentity: "not-verified",
    transport: "not-checked",
  };
  const fail = (status: string) => ({ ...result, ok: false, status });
  if (!["doctor", "inspect", "renew", "pre-renew"].includes(mode))
    return fail("invalid-mode");
  const withinHours =
    options.withinHours === undefined ? 24 : options.withinHours;
  const existingWindowOnly =
    options.existingWindowOnly === undefined
      ? true
      : options.existingWindowOnly;
  if (
    !Number.isFinite(withinHours) ||
    withinHours < 0 ||
    withinHours > 168 ||
    typeof existingWindowOnly !== "boolean" ||
    // The existing Keeper explicitly requires an already-open page for this
    // mutating mode. Link navigation can be done by a prior explicit inspect.
    (mode === "pre-renew" && !existingWindowOnly)
  )
    return fail("invalid-configuration");
  const hasExpectedConfig =
    options.expectedConfigDigest !== undefined ||
    options.expectedConfigPath !== undefined;
  if (
    hasExpectedConfig &&
    (typeof options.expectedConfigDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(options.expectedConfigDigest) ||
      !configuredString(options.expectedConfigPath) ||
      !isAbsolute(options.expectedConfigPath))
  )
    return fail("invalid-configuration");
  const repository = env.WECOM_AUTH_KEEPER_DIR;
  const configPath = env.WECOM_AUTH_KEEPER_CONFIG;
  if (!repository && !configPath) return fail("not-configured");
  if ((options.platform ?? process.platform) !== "darwin")
    return fail("unsupported-platform");
  if (
    !repository ||
    !configPath ||
    !isAbsolute(repository) ||
    !isAbsolute(configPath) ||
    !configuredString(env.WECOM_BOT_ID)
  )
    return fail("invalid-configuration");

  let temporary: string | undefined;
  try {
    const canonicalConfigPath = await realpath(configPath);
    const configBytes = await readFile(canonicalConfigPath);
    // Bind the exact bytes being snapshotted, not a separate preflight read.
    // The path is part of the binding because identical JSON in another parent
    // directory can resolve relative state/CLI paths to different destinations.
    if (
      hasExpectedConfig &&
      (canonicalConfigPath !== options.expectedConfigPath ||
        createHash("sha256").update(configBytes).digest("hex") !==
          options.expectedConfigDigest)
    )
      return fail("configuration-changed");
    const config: unknown = JSON.parse(configBytes.toString("utf8"));
    if (!object(config)) return fail("invalid-configuration");
    if (
      !configuredString(config.aibotid) ||
      !configuredString(config.str_aibotid) ||
      !configuredString(config.bot_chat_name)
    )
      return fail("invalid-configuration");
    if (config.str_aibotid !== env.WECOM_BOT_ID)
      return fail("identity-mismatch");
    result.identity = "configuration-matched";
    const rows = config.target_rows;
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      !rows.every(configuredString) ||
      new Set(rows).size !== rows.length ||
      config.bridge_send_link !== false ||
      config.bridge_monitor !== false
    )
      return fail("unsafe-configuration");
    result.targetRowCount = rows.length;
    const pythonOverride = env.WECOM_AUTH_KEEPER_PYTHON;
    const python = pythonOverride?.trim() ? pythonOverride : config.venv_python;
    if (!configuredString(python) || !isAbsolute(python))
      return fail("invalid-configuration");
    // Freeze the verified identity and scope. Keeper otherwise re-reads a mutable
    // configuration after our identity check. Do not persist any raw result.
    const snapshot = { ...config };
    for (const key of ["state_file", "log_file"]) {
      const path = snapshot[key];
      if (!configuredString(path)) return fail("invalid-configuration");
      snapshot[key] = path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : resolve(dirname(canonicalConfigPath), path);
    }
    const destinations = await Promise.all([
      canonicalConfigPath,
      canonicalDestination(snapshot.state_file as string),
      canonicalDestination(snapshot.log_file as string),
      canonicalDestination(`${snapshot.state_file}.pending.json`),
    ]);
    if (new Set(destinations).size !== destinations.length)
      return fail("unsafe-configuration");
    for (const key of ["wecom_cli", "venv_python"]) {
      const path = snapshot[key];
      if (
        typeof path === "string" &&
        path.includes("/") &&
        !isAbsolute(path) &&
        !path.startsWith("~/")
      )
        snapshot[key] = resolve(dirname(canonicalConfigPath), path);
    }
    temporary = await mkdtemp(join(tmpdir(), "wecom-gateway-keeper-"));
    const snapshotPath = join(temporary, "config.json");
    await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const child = await (options.run ?? runKeeperProcess)({
      command: python,
      args: [
        join(repository, "renew.py"),
        "--config",
        snapshotPath,
        mode === "inspect" ? "--check" : `--${mode}`,
        ...(mode !== "doctor" && existingWindowOnly
          ? ["--existing-window"]
          : []),
        ...(mode === "pre-renew"
          ? ["--within-hours", String(withinHours)]
          : []),
      ],
      cwd: repository,
      timeoutMs:
        mode === "renew" || mode === "pre-renew"
          ? 240_000
          : mode === "inspect"
            ? 30_000
            : 15_000,
    });
    if (child.failure === "timeout") return fail("timeout");
    let payload: unknown;
    try {
      payload = JSON.parse(child.stdout);
    } catch {
      /* Non-JSON process errors retain a fixed, generic status. */
    }
    // Exit 2 is a legitimate unhealthy-page report, not proof that no page was
    // observed. Keep the operation failed while exposing only validated counts.
    if (
      mode !== "doctor" &&
      child.exitCode === 2 &&
      object(payload) &&
      payload.ok === false &&
      payload.error === "permissions_not_healthy"
    ) {
      const observation =
        payload.mode === (mode === "inspect" ? "check" : mode)
          ? pageObservation(payload, rows, Date.now())
          : undefined;
      if (
        !observation ||
        (!observation.expiredCount && !observation.pendingRecovery)
      )
        return fail("invalid-response");
      return {
        ...fail("permissions-unhealthy"),
        identity: "page-verified",
        observation,
      };
    }
    if (child.failure || child.exitCode !== 0) {
      // A fixed vocabulary preserves actionable failures without returning raw
      // keeper messages (which may include paths, links or account identifiers).
      let error: unknown;
      if (object(payload) && payload.ok === false) error = payload.error;
      if (child.exitCode === 4) return fail("keeper-busy");
      if (error === "accessibility_permission_unavailable")
        return fail("accessibility-permission-unavailable");
      if (error === "wecom_not_running") return fail("wecom-not-running");
      if (error === "wecom_window_unavailable")
        return fail("wecom-window-unavailable");
      if (error === "wecom_multiple_instances")
        return fail("wecom-multiple-instances");
      if (error === "page_not_open") return fail("target-page-not-open");
      if (error === "link_not_visible") return fail("target-link-not-visible");
      if (error === "identity_unverified")
        return fail("target-page-unverified");
      if (error === "ambiguous_window") return fail("target-page-ambiguous");
      if (error === "rows_incomplete" || error === "tree_incomplete")
        return fail("target-page-incomplete");
      if (error === "pending_mismatch") return fail("recovery-target-mismatch");
      if (error === "permissions_not_healthy")
        return fail("permissions-unhealthy");
      if (child.exitCode === 3) return fail("keeper-prerequisites-failed");
      return fail("keeper-failed");
    }
    if (
      !object(payload) ||
      payload.ok !== true ||
      payload.mode !== (mode === "inspect" ? "check" : mode)
    )
      return fail("invalid-response");
    if (mode === "doctor") {
      const checks = payload.checks;
      if (
        !object(checks) ||
        ![
          "macos",
          "AppKit",
          "Quartz",
          "ApplicationServices",
          "wecom_cli",
        ].every((key) => checks[key] === true) ||
        payload.gui_access !== "not_checked"
      )
        return fail("invalid-response");
      return { ...result, ok: true, status: "local-prerequisites-ready" };
    }
    const observation = pageObservation(payload, rows, Date.now());
    if (
      !observation ||
      observation.pendingRecovery ||
      observation.expiredCount > 0
    )
      return fail("invalid-response");
    return {
      ...result,
      ok: true,
      identity: "page-verified",
      status: "page-authorizations-verified",
      observation,
    };
  } catch {
    return fail("configuration-or-process-error");
  } finally {
    if (temporary)
      await rm(temporary, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}
