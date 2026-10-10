import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKeeperMaintenancePlugin } from "./lib/keeper-maintenance-plugin.js";
import { readMaintenanceState, runCycle } from "./lib/auth-maintenance.js";

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  emit?: (value: unknown) => void;
  createPlugin?: typeof createKeeperMaintenancePlugin;
  cycle?: typeof runCycle;
  status?: typeof readMaintenanceState;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** Serial, opt-in maintenance worker, deliberately separate from the IM process. */
export async function authMaintenanceMain(
  args: string[],
  deps: Dependencies = {},
): Promise<number> {
  const emit = deps.emit ?? ((value) => console.log(JSON.stringify(value)));
  try {
    const command = args[0] ?? "status";
    if (
      !["once", "watch", "status"].includes(command) ||
      !(
        args.length <= 1 ||
        (args.length === 3 && args[1] === "--env-file" && isAbsolute(args[2]!))
      )
    ) {
      throw new Error("invalid-configuration");
    }
    const env = { ...(deps.env ?? process.env) };
    if (args[2]) {
      const raw = await readFile(args[2], "utf8");
      if (Buffer.byteLength(raw) > 65_536)
        throw new Error("invalid-configuration");
      Object.assign(env, parseEnv(raw));
    }
    const enabled = boolean(env.WECOM_AUTH_MAINTENANCE_ENABLED, false);
    const allowPreRenew = boolean(env.WECOM_AUTH_MAINTENANCE_PRE_RENEW, false);
    boolean(env.WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY, true);
    const withinHours = number(env.WECOM_AUTH_KEEPER_WITHIN_HOURS, 24, 0, 168);
    const interval = number(
      env.WECOM_AUTH_MAINTENANCE_INTERVAL_MS,
      3_600_000,
      60_000,
      86_400_000,
    );
    if (!Number.isSafeInteger(interval))
      throw new Error("invalid-configuration");
    if (!enabled && command !== "status") {
      emit({
        event: "auth_maintenance",
        status: "disabled",
        businessVerified: false,
      });
      return 0;
    }
    const stateDirectory = env.WECOM_AUTH_MAINTENANCE_STATE_DIR;
    if (!stateDirectory || !isAbsolute(stateDirectory))
      throw new Error("invalid-configuration");
    const plugin = await (deps.createPlugin ?? createKeeperMaintenancePlugin)({
      env,
    });
    if (command === "status") {
      const state = await (deps.status ?? readMaintenanceState)(plugin, {
        stateDirectory,
      });
      emit({
        event: "auth_maintenance_status",
        enabled,
        ...state,
        businessVerified: false,
      });
      return state.status === "unavailable" ? 2 : 0;
    }
    let previous = "";
    while (!deps.signal?.aborted) {
      const result = await (deps.cycle ?? runCycle)(plugin, {
        stateDirectory,
        enabled,
        allowPreRenew,
        withinHours,
      });
      // Do not emit every healthy tick or leak provider diagnostics/configuration.
      const signature = JSON.stringify([
        result.status,
        result.code,
        result.businessVerified,
        result.cycle?.before?.providerCode,
        result.cycle?.after?.providerCode,
      ]);
      // Actions are evidence, even if consecutive cycles have the same outcome.
      if (
        signature !== previous ||
        (result.cycle && result.cycle.action !== "none")
      ) {
        emit({ event: "auth_maintenance", ...result });
        previous = signature;
      }
      if (command === "once")
        return ["healthy", "renewed", "disabled"].includes(result.status)
          ? 0
          : 2;
      if (deps.signal?.aborted) break;
      try {
        await (deps.wait ?? ((ms, signal) => delay(ms, undefined, { signal })))(
          interval,
          deps.signal,
        );
      } catch {
        if (!deps.signal?.aborted) throw new Error("worker-failed");
      }
    }
    return 0;
  } catch {
    emit({
      event: "auth_maintenance",
      status: "needs-attention",
      code: "configuration-or-worker-unavailable",
      businessVerified: false,
    });
    return 2;
  }
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false")
    throw new Error("invalid-configuration");
  return value === "true";
}
function number(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error("invalid-configuration");
  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await authMaintenanceMain(process.argv.slice(2), {
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
