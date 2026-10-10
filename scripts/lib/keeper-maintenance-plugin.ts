import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { inspectAuthKeeper, type KeeperReport } from "./auth-keeper.js";
import type {
  AuthMaintenanceObservation,
  AuthMaintenancePlugin,
} from "./auth-maintenance-contract.js";
import { AUTH_MAINTENANCE_PROVIDER_CODES } from "./auth-maintenance-contract.js";

type ProviderCode = (typeof AUTH_MAINTENANCE_PROVIDER_CODES)[number];
const unavailable = (
  code: ProviderCode = "inspection-unavailable",
): AuthMaintenanceObservation => ({
  status: "unavailable",
  identityVerified: false,
  expiredCount: 0,
  pendingRecovery: false,
  businessVerified: false,
  code,
});

function failureCode(status: string): ProviderCode {
  if (status === "timeout") return "keeper-timeout";
  if (status === "invalid-response") return "observation-invalid";
  return AUTH_MAINTENANCE_PROVIDER_CODES.includes(status as ProviderCode)
    ? (status as ProviderCode)
    : "inspection-unavailable";
}

/** Page evidence only. Never promotes a GUI result to a business API result. */
export function keeperObservation(
  report: KeeperReport,
  now = Date.now(),
): AuthMaintenanceObservation {
  const observed = report.observation;
  if (!observed || report.identity !== "page-verified")
    return unavailable(failureCode(report.status));
  // Only fresh, internally consistent evidence may drive a subsequent GUI
  // mutation. This boundary also rejects malformed third-party/fake providers.
  const expired = observed.expiredCount > 0 || observed.pendingRecovery;
  if (
    report.schemaVersion !== 1 ||
    report.event !== "auth_keeper" ||
    !["inspect", "renew", "pre-renew"].includes(report.mode) ||
    report.scope !== "optional-cli-capabilities" ||
    !Number.isInteger(report.targetRowCount) ||
    report.targetRowCount < 1 ||
    !Number.isSafeInteger(observed.observedAtMs) ||
    observed.observedAtMs > now ||
    now - observed.observedAtMs > 60_000 ||
    !Number.isInteger(observed.expiredCount) ||
    observed.expiredCount < 0 ||
    observed.expiredCount > report.targetRowCount ||
    typeof observed.pendingRecovery !== "boolean" ||
    (observed.earliestExpiryMs !== null &&
      (!Number.isSafeInteger(observed.earliestExpiryMs) ||
        observed.earliestExpiryMs < 0)) ||
    (!observed.expiredCount &&
      (observed.earliestExpiryMs === null ||
        observed.earliestExpiryMs <= now)) ||
    (expired
      ? report.ok !== false || report.status !== "permissions-unhealthy"
      : report.ok !== true || report.status !== "page-authorizations-verified")
  )
    return unavailable("observation-invalid");
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
        env.WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY,
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
        return unavailable("configuration-changed");
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
