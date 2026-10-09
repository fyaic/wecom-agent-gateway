import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { inspectAuthKeeper, type KeeperReport } from "./auth-keeper.js";
import type {
  AuthMaintenanceObservation,
  AuthMaintenancePlugin,
} from "./auth-maintenance-contract.js";

const unavailable = (): AuthMaintenanceObservation => ({
  status: "unavailable",
  identityVerified: false,
  expiredCount: 0,
  pendingRecovery: false,
  businessVerified: false,
  code: "inspection-unavailable",
});

/** Page evidence only. Never promotes a GUI result to a business API result. */
export function keeperObservation(
  report: KeeperReport,
): AuthMaintenanceObservation {
  const observed = report.observation;
  if (!observed || report.identity !== "page-verified") return unavailable();
  return {
    status:
      observed.expiredCount > 0 || observed.pendingRecovery
        ? "expired"
        : "healthy",
    identityVerified: true,
    ...(observed.earliestExpiryMs !== null
      ? { earliestExpiryMs: observed.earliestExpiryMs }
      : {}),
    expiredCount: observed.expiredCount,
    pendingRecovery: observed.pendingRecovery,
    businessVerified: false,
    code: "business-validation-required",
  };
}

export async function createKeeperMaintenancePlugin(options: {
  env: NodeJS.ProcessEnv;
  inspect?: typeof inspectAuthKeeper;
}): Promise<AuthMaintenancePlugin> {
  const env = { ...options.env };
  const config = env.WECOM_AUTH_KEEPER_CONFIG;
  if (!config || !isAbsolute(config) || !env.WECOM_BOT_ID?.trim()) {
    throw new Error("invalid-configuration");
  }
  const canonicalConfig = await realpath(config);
  const initial = await readFile(canonicalConfig);
  if (initial.length > 65_536) throw new Error("invalid-configuration");
  const fingerprint = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const configHash = fingerprint(initial);
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        env.WECOM_BOT_ID,
        canonicalConfig,
        configHash,
        env.WECOM_AUTH_KEEPER_DIR,
        env.WECOM_AUTH_KEEPER_PYTHON,
      ]),
    )
    .digest("hex");
  const inspect = options.inspect ?? inspectAuthKeeper;
  const call = async (
    mode: "inspect" | "renew" | "pre-renew",
    withinHours?: number,
  ) => {
    try {
      // Configuration changes require an explicit process restart/new binding.
      if (fingerprint(await readFile(config)) !== configHash)
        return unavailable();
      return keeperObservation(
        await inspect({
          mode,
          env,
          withinHours,
          expectedConfigDigest: configHash,
          expectedConfigPath: canonicalConfig,
          existingWindowOnly:
            mode === "pre-renew" ||
            env.WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY !== "false",
        }),
      );
    } catch {
      return unavailable();
    }
  };
  return {
    id: "wecom-auth-keeper",
    binding,
    inspect: () => call("inspect"),
    renew: ({ preRenew, withinHours }) =>
      call(preRenew ? "pre-renew" : "renew", withinHours),
  };
}
