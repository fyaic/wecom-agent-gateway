import { describe, expect, it, vi } from "vitest";
import { authMaintenanceMain } from "./auth-maintenance.js";
import type { AuthMaintenanceResult } from "./lib/auth-maintenance-contract.js";

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
