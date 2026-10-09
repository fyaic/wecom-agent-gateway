import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AuthMaintenanceObservation,
  AuthMaintenanceOptions,
  AuthMaintenancePlugin,
  AuthMaintenanceResult,
  AuthMaintenanceStateView,
} from "./auth-maintenance-contract.js";

interface State {
  version: 1;
  attempts: number;
  failures: number;
  nextAttemptAtMs?: number;
  nextPreRenewAtMs?: number;
  intent?: { atMs: number; preRenew: boolean; expiryMs?: number };
}

/** A single opt-in cycle. Scheduling and native UI live outside this engine. */
export async function runCycle(
  plugin: AuthMaintenancePlugin,
  options: AuthMaintenanceOptions,
): Promise<AuthMaintenanceResult> {
  if (!options.enabled) return result("disabled", "disabled", 0);
  const now = options.now ?? Date.now();
  const withinHours = options.withinHours ?? 24;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 60_000;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(plugin.id) ||
    !/^[a-f0-9]{16,128}$/i.test(plugin.binding) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isFinite(withinHours) ||
    withinHours < 0 ||
    withinHours > 168 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < 1 ||
    backoffMs > 3_600_000
  )
    return result("needs-attention", "state-unavailable", 0);

  const directory = resolve(options.stateDirectory);
  const key = createHash("sha256")
    .update(`${plugin.id}\0${plugin.binding}`)
    .digest("hex");
  const statePath = join(directory, `${key}.json`);
  const lockPath = join(directory, `${key}.lock`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error();
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    return result(
      errorCode(error) === "EEXIST" ? "locked" : "needs-attention",
      errorCode(error) === "EEXIST" ? "lock-held" : "state-unavailable",
      0,
    );
  }
  let state: State = { version: 1, attempts: 0, failures: 0 };
  try {
    state = await loadState(statePath);
    const persist = () => saveState(statePath, state);
    const defer = async (code: AuthMaintenanceResult["code"]) => {
      state.failures++;
      state.nextAttemptAtMs =
        now +
        Math.min(backoffMs * 2 ** Math.min(state.failures - 1, 10), 3_600_000);
      await persist();
      return {
        ...result("needs-attention", code, state.attempts),
        nextAttemptAtMs: state.nextAttemptAtMs,
      };
    };
    if (state.nextAttemptAtMs !== undefined && state.nextAttemptAtMs > now)
      return {
        ...result("backoff", "backoff", state.attempts),
        nextAttemptAtMs: state.nextAttemptAtMs,
      };
    let observation: AuthMaintenanceObservation;
    try {
      observation = validateObservation(await plugin.inspect());
    } catch {
      return await defer("inspection-unavailable");
    }
    if (!observation.identityVerified)
      return await defer("identity-unverified");
    if (pageHealthy(observation, now)) {
      // External/manual recovery can safely settle an interrupted action.
      const needsPreRenew =
        options.allowPreRenew === true &&
        observation.earliestExpiryMs !== undefined &&
        now >= (state.nextPreRenewAtMs ?? 0) &&
        observation.earliestExpiryMs <= now + withinHours * 3_600_000;
      if (
        (state.intent && intentVerified(state, observation)) ||
        (!state.intent && !needsPreRenew)
      ) {
        state = {
          version: 1,
          attempts: 0,
          failures: 0,
          nextPreRenewAtMs: state.intent
            ? nextPreRenewAt(now, observation.earliestExpiryMs, withinHours)
            : state.nextPreRenewAtMs,
        };
        await persist();
        return {
          ...result(
            "healthy",
            observation.businessVerified
              ? "healthy"
              : "business-validation-required",
            0,
          ),
          businessVerified: observation.businessVerified === true,
        };
      }
    }
    // Only an explicitly observed pending-recovery state authorizes resuming
    // recovery after an uncertain action. It never authorizes another revoke.
    if (state.intent && !observation.pendingRecovery)
      return await defer("action-outcome-unknown");
    if (observation.status === "unavailable")
      return await defer("inspection-unavailable");
    const expired =
      observation.pendingRecovery ||
      observation.status === "expired" ||
      observation.expiredCount > 0 ||
      (observation.earliestExpiryMs !== undefined &&
        observation.earliestExpiryMs <= now);
    const preRenew =
      !expired &&
      options.allowPreRenew === true &&
      observation.earliestExpiryMs !== undefined &&
      observation.earliestExpiryMs <= now + withinHours * 3_600_000;
    if (!expired && !preRenew)
      return await defer("business-validation-required");
    if (state.attempts >= maxAttempts)
      return await defer("attempt-limit-reached");
    state.attempts++;
    state.intent = {
      atMs: now,
      preRenew,
      expiryMs: observation.earliestExpiryMs,
    };
    await persist(); // Durable intent precedes any provider side effect.
    try {
      validateObservation(await plugin.renew({ preRenew, withinHours }));
    } catch {
      return await defer("action-outcome-unknown");
    }
    // A returned UI action is not a business API success. Independently inspect.
    try {
      observation = validateObservation(await plugin.inspect());
    } catch {
      return await defer("action-outcome-unknown");
    }
    if (!observation.identityVerified || observation.pendingRecovery)
      return await defer(
        !observation.identityVerified
          ? "identity-unverified"
          : "recovery-pending",
      );
    if (pageHealthy(observation, now) && intentVerified(state, observation)) {
      state = {
        version: 1,
        attempts: 0,
        failures: 0,
        nextPreRenewAtMs: nextPreRenewAt(
          now,
          observation.earliestExpiryMs,
          withinHours,
        ),
      };
      await persist();
      return {
        ...result(
          "renewed",
          observation.businessVerified
            ? "renewed-business-verified"
            : "business-validation-required",
          0,
        ),
        businessVerified: observation.businessVerified === true,
      };
    }
    if (preRenew && pageHealthy(observation, now))
      return {
        ...(await defer("expiry-not-extended")),
        businessVerified: observation.businessVerified === true,
      };
    if (observation.status === "healthy" && observation.expiredCount === 0)
      return await defer("business-validation-required");
    // A completed, observed failed renewal may retry after backoff; uncertain
    // actions retain their intent and never trigger another revoke automatically.
    if (observation.status === "expired") delete state.intent;
    return await defer("renewal-not-verified");
  } catch {
    return result("needs-attention", "state-unavailable", state.attempts);
  } finally {
    // Only this cycle's acquired lock is removed. Existing/crashed locks require
    // operator investigation; no age/PID heuristic can delete another owner.
    try {
      await rm(lockPath, { recursive: true, force: true });
    } catch {
      return result("needs-attention", "state-unavailable", state.attempts);
    }
  }
}

/** Read-only status: no directory creation, lock removal, GUI, or API probe. */
export async function readMaintenanceState(
  plugin: Pick<AuthMaintenancePlugin, "id" | "binding">,
  options: Pick<AuthMaintenanceOptions, "stateDirectory">,
): Promise<AuthMaintenanceStateView> {
  const base: AuthMaintenanceStateView = {
    status: "absent",
    locked: false,
    pendingIntent: false,
    attempts: 0,
    failures: 0,
  };
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(plugin.id) ||
    !/^[a-f0-9]{16,128}$/i.test(plugin.binding)
  )
    return { ...base, status: "unavailable" };
  const directory = resolve(options.stateDirectory);
  const key = createHash("sha256")
    .update(`${plugin.id}\0${plugin.binding}`)
    .digest("hex");
  try {
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0
    )
      return { ...base, status: "unavailable" };
    try {
      await lstat(join(directory, `${key}.lock`));
      base.locked = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try {
      await lstat(join(directory, `${key}.json`));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return base;
      throw error;
    }
    const state = await loadState(join(directory, `${key}.json`));
    return {
      status: "present",
      locked: base.locked,
      pendingIntent: Boolean(state.intent),
      attempts: state.attempts,
      failures: state.failures,
      ...(state.nextAttemptAtMs !== undefined
        ? { nextAttemptAtMs: state.nextAttemptAtMs }
        : {}),
      ...(state.nextPreRenewAtMs !== undefined
        ? { nextPreRenewAtMs: state.nextPreRenewAtMs }
        : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: errorCode(error) === "ENOENT" ? "absent" : "unavailable",
    };
  }
}

function intentVerified(
  state: State,
  value: AuthMaintenanceObservation,
): boolean {
  return (
    !state.intent?.preRenew ||
    (state.intent.expiryMs !== undefined &&
      value.earliestExpiryMs !== undefined &&
      value.earliestExpiryMs > state.intent.expiryMs)
  );
}

function pageHealthy(value: AuthMaintenanceObservation, now: number): boolean {
  return (
    value.status === "healthy" &&
    value.identityVerified &&
    value.expiredCount === 0 &&
    !value.pendingRecovery &&
    (value.earliestExpiryMs === undefined || value.earliestExpiryMs > now)
  );
}

function validateObservation(
  value: AuthMaintenanceObservation,
): AuthMaintenanceObservation {
  if (
    !value ||
    !["healthy", "expired", "unavailable"].includes(value.status) ||
    typeof value.identityVerified !== "boolean" ||
    typeof value.pendingRecovery !== "boolean" ||
    !Number.isSafeInteger(value.expiredCount) ||
    value.expiredCount < 0 ||
    (value.earliestExpiryMs !== undefined &&
      (!Number.isSafeInteger(value.earliestExpiryMs) ||
        value.earliestExpiryMs < 0)) ||
    (value.businessVerified !== undefined &&
      typeof value.businessVerified !== "boolean")
  )
    throw new Error();
  return value;
}

async function loadState(path: string): Promise<State> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 8_192 ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error();
    const value = JSON.parse(await readFile(path, "utf8")) as State;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 0 ||
      !Number.isSafeInteger(value.failures) ||
      value.failures < 0 ||
      !optionalTime(value.nextAttemptAtMs) ||
      !optionalTime(value.nextPreRenewAtMs) ||
      (value.intent !== undefined &&
        (value.intent === null ||
          typeof value.intent !== "object" ||
          Array.isArray(value.intent) ||
          !Number.isSafeInteger(value.intent.atMs) ||
          value.intent.atMs < 0 ||
          typeof value.intent.preRenew !== "boolean" ||
          !optionalTime(value.intent.expiryMs)))
    )
      throw new Error();
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return { version: 1, attempts: 0, failures: 0 };
    throw error;
  }
}

async function saveState(path: string, state: State): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function optionalTime(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function nextPreRenewAt(
  now: number,
  expiry: number | undefined,
  withinHours: number,
): number {
  // At least one hour between successful revocations, but never permanently
  // suppress the next authorization lifetime's pre-renew window.
  return Math.max(now + 3_600_000, (expiry ?? now) - withinHours * 3_600_000);
}
function result(
  status: AuthMaintenanceResult["status"],
  code: AuthMaintenanceResult["code"],
  attempts: number,
): AuthMaintenanceResult {
  return { status, code, attempts, businessVerified: false };
}
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
