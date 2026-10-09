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
}

export interface AuthMaintenanceStateView {
  status: "absent" | "present" | "unavailable";
  locked: boolean;
  pendingIntent: boolean;
  attempts: number;
  failures: number;
  nextAttemptAtMs?: number;
  nextPreRenewAtMs?: number;
}

export interface AuthMaintenanceOptions {
  stateDirectory: string;
  enabled?: boolean;
  allowPreRenew?: boolean;
  withinHours?: number;
  now?: number;
  maxAttempts?: number;
  backoffMs?: number;
}
