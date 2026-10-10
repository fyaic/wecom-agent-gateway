import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMaintenanceMain } from "./auth-maintenance.js";
import { readMaintenanceState } from "./lib/auth-maintenance.js";
import type {
  AuthMaintenanceObservation,
  AuthMaintenanceResult,
} from "./lib/auth-maintenance-contract.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const plugin = {
  id: "fake",
  binding: "a".repeat(64),
  inspect: vi.fn(),
  renew: vi.fn(),
};
const env = {
  WECOM_AUTH_MAINTENANCE_ENABLED: "true",
  WECOM_AUTH_MAINTENANCE_STATE_DIR: "/private/state",
};
const healthy: AuthMaintenanceResult = {
  status: "healthy",
  code: "business-validation-required",
  attempts: 0,
  businessVerified: false,
};

describe("authorization maintenance worker", () => {
  it("logs changed fixed provider diagnostics but not timestamp-only changes", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    let count = 0;
    await authMaintenanceMain(["watch"], {
      env,
      signal: controller.signal,
      createPlugin: async () => plugin,
      emit,
      cycle: async () => {
        count++;
        if (count === 3) controller.abort();
        return {
          ...healthy,
          status: "needs-attention",
          code: "identity-unverified",
          cycle: {
            startedAtMs: count * 10,
            finishedAtMs: count * 10 + 2,
            status: "needs-attention",
            code: "identity-unverified",
            businessVerified: false,
            action: "none",
            before: {
              checkedAtMs: count * 10 + 1,
              status: "unavailable",
              identityVerified: false,
              businessVerified: false,
              providerCode:
                count === 1
                  ? "target-page-not-open"
                  : "target-link-not-visible",
            },
          },
        };
      },
      wait: async () => {},
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toMatchObject({
      cycle: { before: { providerCode: "target-link-not-visible" } },
    });
  });

  it("retains consecutive action evidence even when outcome signatures match", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    let count = 0;
    await authMaintenanceMain(["watch"], {
      env,
      signal: controller.signal,
      createPlugin: async () => plugin,
      emit,
      cycle: async () => {
        count++;
        if (count === 2) controller.abort();
        return {
          ...healthy,
          status: "renewed",
          cycle: {
            startedAtMs: count * 10,
            finishedAtMs: count * 10 + 1,
            status: "renewed",
            code: "business-validation-required",
            businessVerified: false,
            action: "renew",
          },
        };
      },
      wait: async () => {},
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toMatchObject({
      cycle: { action: "renew", startedAtMs: 20, finishedAtMs: 21 },
    });
  });

  it("gracefully settles the real engine, releases its own lock, and restarts without duplicate renewal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wecom-worker-test-"));
    directories.push(directory);
    const localEnv = { ...env, WECOM_AUTH_MAINTENANCE_STATE_DIR: directory };
    const controller = new AbortController();
    const observation: AuthMaintenanceObservation = {
      status: "healthy",
      identityVerified: true,
      expiredCount: 0,
      pendingRecovery: false,
      businessVerified: false,
      code: "business-validation-required",
    };
    let release!: () => void;
    let started!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let current: AuthMaintenanceObservation = {
      ...observation,
      status: "expired",
      expiredCount: 1,
    };
    const localPlugin = {
      id: "fake",
      binding: "a".repeat(64),
      inspect: vi.fn(async () => current),
      renew: vi.fn(async () => {
        started();
        await gated;
        current = observation;
        return observation;
      }),
    };
    const emit = vi.fn();
    const wait = vi.fn();
    const running = authMaintenanceMain(["watch"], {
      env: localEnv,
      signal: controller.signal,
      createPlugin: async () => localPlugin,
      emit,
      wait,
    });
    await began;
    controller.abort();
    expect(
      await readMaintenanceState(localPlugin, { stateDirectory: directory }),
    ).toMatchObject({ locked: true, pendingIntent: true });
    release();
    expect(await running).toBe(0);
    expect(wait).not.toHaveBeenCalled();
    expect(
      await readMaintenanceState(localPlugin, { stateDirectory: directory }),
    ).toMatchObject({
      locked: false,
      pendingIntent: false,
      lastAction: {
        status: "renewed",
        action: "renew",
        before: { status: "expired" },
        after: { status: "healthy", businessVerified: false },
      },
    });
    expect(
      await authMaintenanceMain(["once"], {
        env: localEnv,
        createPlugin: async () => localPlugin,
        emit,
      }),
    ).toBe(0);
    expect(localPlugin.renew).toHaveBeenCalledOnce();
    const inspections = localPlugin.inspect.mock.calls.length;
    await authMaintenanceMain(["status"], {
      env: localEnv,
      createPlugin: async () => localPlugin,
      emit,
    });
    expect(localPlugin.inspect).toHaveBeenCalledTimes(inspections);
    expect(emit.mock.calls.at(-1)![0]).toMatchObject({
      event: "auth_maintenance_status",
      businessVerified: false,
      lastAction: { action: "renew" },
      lastCycle: { action: "none" },
    });
  });

  it("is disabled without creating a plugin or touching GUI", async () => {
    const createPlugin = vi.fn();
    expect(
      await authMaintenanceMain(["watch"], {
        env: {},
        createPlugin,
        emit: vi.fn(),
      }),
    ).toBe(0);
    expect(createPlugin).not.toHaveBeenCalled();
  });
  it("once passes explicit policy, not implicit pre-renew", async () => {
    const cycle = vi.fn(async () => healthy);
    expect(
      await authMaintenanceMain(["once"], {
        env,
        createPlugin: async () => plugin,
        cycle,
        emit: vi.fn(),
      }),
    ).toBe(0);
    expect(cycle).toHaveBeenCalledWith(
      plugin,
      expect.objectContaining({
        enabled: true,
        allowPreRenew: false,
        withinHours: 24,
      }),
    );
  });
  it("status never inspects or renews", async () => {
    const cycle = vi.fn();
    const status = vi.fn(async () => ({
      status: "absent" as const,
      locked: false,
      pendingIntent: false,
      attempts: 0,
      failures: 0,
    }));
    await authMaintenanceMain(["status"], {
      env,
      createPlugin: async () => plugin,
      cycle,
      status,
      emit: vi.fn(),
    });
    expect(cycle).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledOnce();
  });
  it("serializes ticks and emits only status transitions", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const emit = vi.fn();
    let ticks = 0;
    const cycle = vi.fn(async () => {
      order.push("cycle");
      ticks++;
      return healthy;
    });
    await authMaintenanceMain(["watch"], {
      env,
      signal: controller.signal,
      createPlugin: async () => plugin,
      cycle,
      emit,
      wait: async () => {
        order.push("wait");
        if (ticks === 3) controller.abort();
      },
    });
    expect(order).toEqual(["cycle", "wait", "cycle", "wait", "cycle", "wait"]);
    expect(emit).toHaveBeenCalledOnce();
  });
  it("stops after an in-flight cycle settles", async () => {
    const controller = new AbortController();
    const wait = vi.fn();
    const cycle = vi.fn(async () => {
      controller.abort();
      return healthy;
    });
    await authMaintenanceMain(["watch"], {
      env,
      signal: controller.signal,
      createPlugin: async () => plugin,
      cycle,
      wait,
      emit: vi.fn(),
    });
    expect(cycle).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
  it.each([
    { WECOM_AUTH_MAINTENANCE_ENABLED: "yes" },
    { WECOM_AUTH_MAINTENANCE_PRE_RENEW: "1" },
    { WECOM_AUTH_MAINTENANCE_INTERVAL_MS: "5" },
    { WECOM_AUTH_KEEPER_WITHIN_HOURS: "169" },
    { WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY: "sometimes" },
  ])("rejects unsafe policy %j", async (override) => {
    const createPlugin = vi.fn();
    expect(
      await authMaintenanceMain(["once"], {
        env: { ...env, ...override },
        createPlugin,
        emit: vi.fn(),
      }),
    ).toBe(2);
    expect(createPlugin).not.toHaveBeenCalled();
  });
  it("never prints raw exception text", async () => {
    const output: unknown[] = [];
    await authMaintenanceMain(["once"], {
      env,
      createPlugin: async () => {
        throw new Error("private-bot-secret");
      },
      emit: (v) => output.push(v),
    });
    expect(JSON.stringify(output)).not.toContain("private-bot-secret");
  });
});
