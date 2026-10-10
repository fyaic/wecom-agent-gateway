/** Optional local authorization maintenance. Never a dependency of IM runtime. */
export interface AuthMaintenanceObservation {
  status: "healthy" | "expired" | "unavailable";
  identityVerified: boolean;
  earliestExpiryMs?: number;
  expiredCount: number;
  pendingRecovery: boolean;
  /** True only after a read-only business API probe, not an authorization page. */
  businessVerified?: boolean;
  /** Untrusted provider diagnostic; the engine never publishes it verbatim. */
  code: string;
}

export interface AuthMaintenancePlugin {
  id: string;
  /** Non-sensitive hex digest of the identity/configuration being maintained. */
  binding: string;
  inspect(): Promise<AuthMaintenanceObservation>;
  renew(options: {
    preRenew: boolean;
    withinHours: number;
  }): Promise<AuthMaintenanceObservation>;
}

export const AUTH_MAINTENANCE_CODES = [
  "disabled",
  "healthy",
  "renewed-business-verified",
  "lock-held",
  "state-unavailable",
  "inspection-unavailable",
  "identity-unverified",
  "business-validation-required",
  "recovery-pending",
  "action-outcome-unknown",
  "attempt-limit-reached",
  "renewal-not-verified",
  "expiry-not-extended",
  "backoff",
] as const;

/** Fixed provider diagnostics only; never persist arbitrary upstream messages. */
export const AUTH_MAINTENANCE_PROVIDER_CODES = [
  "target-page-not-open",
  "target-link-not-visible",
  "target-page-unverified",
  "target-page-ambiguous",
  "target-page-incomplete",
  "configuration-changed",
  "identity-mismatch",
  "keeper-busy",
  "keeper-timeout",
  "keeper-prerequisites-failed",
  "recovery-target-mismatch",
  "observation-invalid",
  "inspection-unavailable",
  "business-validation-required",
] as const;

export interface AuthMaintenanceInspectionSummary {
  checkedAtMs: number;
  status: AuthMaintenanceObservation["status"];
  identityVerified: boolean;
  businessVerified: boolean;
  providerCode: (typeof AUTH_MAINTENANCE_PROVIDER_CODES)[number];
  earliestExpiryMs?: number;
  expiredCount?: number;
  pendingRecovery?: boolean;
}

export interface AuthMaintenanceCycleSummary {
  startedAtMs: number;
  finishedAtMs: number;
  status: AuthMaintenanceResult["status"];
  code: AuthMaintenanceResult["code"];
  businessVerified: boolean;
  action: "none" | "renew" | "pre-renew";
  before?: AuthMaintenanceInspectionSummary;
  after?: AuthMaintenanceInspectionSummary;
}

export interface AuthMaintenanceResult {
  status:
    | "disabled"
    | "healthy"
    | "renewed"
    | "backoff"
    | "locked"
    | "needs-attention";
  code: (typeof AUTH_MAINTENANCE_CODES)[number];
  attempts: number;
  businessVerified: boolean;
  nextAttemptAtMs?: number;
  cycle?: AuthMaintenanceCycleSummary;
}

export interface AuthMaintenanceStateView {
  status: "absent" | "present" | "unavailable";
  locked: boolean;
  pendingIntent: boolean;
  attempts: number;
  failures: number;
  nextAttemptAtMs?: number;
  nextPreRenewAtMs?: number;
  /** Historical evidence only, not a fresh health check or worker heartbeat. */
  lastCycle?: AuthMaintenanceCycleSummary;
  lastInspection?: AuthMaintenanceInspectionSummary;
  lastAction?: AuthMaintenanceCycleSummary;
}

export interface AuthMaintenanceOptions {
  stateDirectory: string;
  enabled?: boolean;
  allowPreRenew?: boolean;
  withinHours?: number;
  now?: number;
  maxAttempts?: number;
  backoffMs?: number;
  /** Deterministic test hook. Production uses the real wall clock. */
  clock?: () => number;
}
