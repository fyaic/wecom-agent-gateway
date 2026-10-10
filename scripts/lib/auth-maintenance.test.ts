import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_MAINTENANCE_CODES,
  type AuthMaintenanceObservation,
  type AuthMaintenancePlugin,
} from "./auth-maintenance-contract.js";
import { readMaintenanceState, runCycle } from "./auth-maintenance.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "wecom-maintenance-test-"));
  directories.push(path);
  return path;
}
const healthy = (
  overrides: Partial<AuthMaintenanceObservation> = {},
): AuthMaintenanceObservation => ({
  status: "healthy",
  identityVerified: true,
  expiredCount: 0,
  pendingRecovery: false,
  businessVerified: true,
  code: "upstream-untrusted",
  ...overrides,
});
const expired = () =>
  healthy({ status: "expired", expiredCount: 1, businessVerified: false });
function fake(initial = expired()) {
  let current = initial;
  const plugin: AuthMaintenancePlugin = {
    id: "fake",
    binding: "a".repeat(64),
    inspect: vi.fn(async () => current),
    renew: vi.fn(async () => {
      current = healthy();
      return current;
    }),
  };
  return {
    plugin,
    set: (value: AuthMaintenanceObservation) => {
      current = value;
    },
  };
}

describe("optional authorization maintenance engine", () => {
  it("keeps before/after evidence and last action across a later healthy cycle", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(expired());
    let wallClock = 1_000;
    const options = {
      stateDirectory,
      enabled: true,
      now: 1,
      clock: () => wallClock++,
    };
    const renewed = await runCycle(fixture.plugin, options);
    expect(renewed.cycle).toMatchObject({
      startedAtMs: 1_000,
      finishedAtMs: 1_003,
      action: "renew",
      status: "renewed",
      before: {
        checkedAtMs: 1_001,
        status: "expired",
        businessVerified: false,
        providerCode: "inspection-unavailable",
      },
      after: { checkedAtMs: 1_002, status: "healthy", businessVerified: true },
    });
    await runCycle(fixture.plugin, { ...options, now: 2 });
    const state = await readMaintenanceState(fixture.plugin, {
      stateDirectory,
    });
    expect(state.lastAction).toEqual(renewed.cycle);
    expect(state.lastCycle).toMatchObject({
      action: "none",
      startedAtMs: 1_004,
      finishedAtMs: 1_006,
    });
    expect(state.lastCycle?.after).toBeUndefined();
    expect(state.lastInspection).toEqual(state.lastCycle?.before);
    expect(fixture.plugin.renew).toHaveBeenCalledOnce();
    expect(JSON.stringify(state)).not.toContain("upstream-untrusted");
  });

  it("does not turn a backoff tick into a fresh inspection, including after restart", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(
      healthy({
        status: "unavailable",
        code: "target-page-not-open",
        businessVerified: false,
      }),
    );
    let wallClock = 2_000;
    const options = {
      stateDirectory,
      enabled: true,
      now: 1,
      clock: () => wallClock++,
    };
    const failed = await runCycle(fixture.plugin, options);
    expect(failed.cycle?.before?.providerCode).toBe("target-page-not-open");
    const restarted = fake(healthy());
    const delayed = await runCycle(restarted.plugin, { ...options, now: 2 });
    expect(delayed).toMatchObject({
      status: "backoff",
      cycle: { action: "none" },
    });
    expect(delayed.cycle?.before).toBeUndefined();
    expect(delayed.cycle?.after).toBeUndefined();
    expect(restarted.plugin.inspect).not.toHaveBeenCalled();
    expect(
      (await readMaintenanceState(restarted.plugin, { stateDirectory }))
        .lastInspection,
    ).toEqual(failed.cycle?.before);
    await runCycle(restarted.plugin, {
      ...options,
      now: failed.nextAttemptAtMs,
    });
    expect(restarted.plugin.inspect).toHaveBeenCalledOnce();
    expect(restarted.plugin.renew).not.toHaveBeenCalled();
  });

  it("records thrown inspections without exception text or invented expiry facts", async () => {
    const stateDirectory = await temporary();
    const fixture = fake();
    fixture.plugin.inspect = vi.fn(async () => {
      throw new Error("SECRET upstream details");
    });
    const result = await runCycle(fixture.plugin, {
      stateDirectory,
      enabled: true,
    });
    expect(result.cycle?.before).toMatchObject({
      status: "unavailable",
      providerCode: "inspection-unavailable",
      businessVerified: false,
    });
    expect(result.cycle?.before?.expiredCount).toBeUndefined();
    expect(result.cycle?.before?.earliestExpiryMs).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fixture.plugin.renew).not.toHaveBeenCalled();
  });

  it("uses real finish timestamps by default, not the policy test clock", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(healthy());
    const start = Date.now();
    const result = await runCycle(fixture.plugin, {
      stateDirectory,
      enabled: true,
      now: 1,
    });
    expect(result.cycle!.startedAtMs).toBeGreaterThanOrEqual(start);
    expect(result.cycle!.finishedAtMs).toBeGreaterThanOrEqual(
      result.cycle!.before!.checkedAtMs,
    );
    expect(result.cycle!.finishedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    {
      lastInspection: {
        checkedAtMs: 1,
        status: "healthy",
        identityVerified: true,
        businessVerified: false,
        providerCode: "SECRET",
      },
    },
    {
      lastInspection: {
        checkedAtMs: 1,
        status: "healthy",
        identityVerified: true,
        businessVerified: false,
        providerCode: "inspection-unavailable",
        secret: "SECRET",
      },
    },
    {
      lastCycle: {
        startedAtMs: 10,
        finishedAtMs: 9,
        status: "healthy",
        code: "healthy",
        businessVerified: true,
        action: "none",
      },
    },
    {
      lastCycle: {
        startedAtMs: 1,
        finishedAtMs: 2,
        status: "healthy",
        code: "healthy",
        businessVerified: true,
        action: "none",
        after: {
          checkedAtMs: 5,
          status: "healthy",
          identityVerified: true,
          businessVerified: true,
          providerCode: "inspection-unavailable",
        },
      },
    },
    {
      lastAction: {
        startedAtMs: 1,
        finishedAtMs: 2,
        status: "healthy",
        code: "healthy",
        businessVerified: true,
        action: "none",
      },
    },
    { lastInspection: null },
  ])(
    "rejects corrupt/extra history without exposing it: %j",
    async (history) => {
      const stateDirectory = await temporary();
      const fixture = fake(healthy());
      await runCycle(fixture.plugin, { stateDirectory, enabled: true });
      const file = (await readdir(stateDirectory)).find((name) =>
        name.endsWith(".json"),
      )!;
      await writeFile(
        join(stateDirectory, file),
        JSON.stringify({ version: 1, attempts: 0, failures: 0, ...history }),
      );
      vi.mocked(fixture.plugin.inspect).mockClear();
      const status = await readMaintenanceState(fixture.plugin, {
        stateDirectory,
      });
      expect(status.status).toBe("unavailable");
      expect(JSON.stringify(status)).not.toContain("SECRET");
      expect(
        (await runCycle(fixture.plugin, { stateDirectory, enabled: true }))
          .code,
      ).toBe("state-unavailable");
      expect(fixture.plugin.inspect).not.toHaveBeenCalled();
    },
  );

  it("reads legacy v1 state without pretending it has inspection history", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(healthy());
    await runCycle(fixture.plugin, { stateDirectory, enabled: true });
    const file = (await readdir(stateDirectory)).find((name) =>
      name.endsWith(".json"),
    )!;
    await writeFile(
      join(stateDirectory, file),
      JSON.stringify({ version: 1, attempts: 0, failures: 0 }),
    );
    const state = await readMaintenanceState(fixture.plugin, {
      stateDirectory,
    });
    expect(state.status).toBe("present");
    expect(state.lastCycle).toBeUndefined();
    expect(state.lastInspection).toBeUndefined();
  });

  it.each([null, false, 0])(
    "rejects malformed persisted intent %j before inspecting or authorizing",
    async (intent) => {
      const stateDirectory = await temporary();
      const fixture = fake(healthy());
      await runCycle(fixture.plugin, { stateDirectory, enabled: true, now: 1 });
      const file = (await readdir(stateDirectory)).find((name) =>
        name.endsWith(".json"),
      )!;
      await writeFile(
        join(stateDirectory, file),
        JSON.stringify({ version: 1, attempts: 0, failures: 0, intent }),
      );
      vi.mocked(fixture.plugin.inspect).mockClear();
      expect(
        await runCycle(fixture.plugin, {
          stateDirectory,
          enabled: true,
          now: 2,
        }),
      ).toMatchObject({ status: "needs-attention", code: "state-unavailable" });
      expect(fixture.plugin.inspect).not.toHaveBeenCalled();
      expect(fixture.plugin.renew).not.toHaveBeenCalled();
    },
  );
  it("is disabled by default and status reads do not create directories or call providers", async () => {
    const stateDirectory = join(await temporary(), "not-created");
    const { plugin } = fake();
    expect((await runCycle(plugin, { stateDirectory })).status).toBe(
      "disabled",
    );
    expect(
      await readMaintenanceState(plugin, { stateDirectory }),
    ).toMatchObject({ status: "absent", locked: false });
    await expect(lstat(stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(plugin.inspect).not.toHaveBeenCalled();
    expect(plugin.renew).not.toHaveBeenCalled();
  });

  it("persists private intent before renewal, then independently checks business health", async () => {
    const stateDirectory = await temporary();
    const fixture = fake();
    fixture.plugin.renew = vi.fn(async () => {
      expect(
        await readMaintenanceState(fixture.plugin, { stateDirectory }),
      ).toMatchObject({ locked: true, pendingIntent: true, attempts: 1 });
      const [file] = (await readdir(stateDirectory)).filter((name) =>
        name.endsWith(".json"),
      );
      expect((await lstat(join(stateDirectory, file!))).mode & 0o777).toBe(
        0o600,
      );
      fixture.set(healthy());
      return healthy();
    });
    expect(
      await runCycle(fixture.plugin, { stateDirectory, enabled: true, now: 1 }),
    ).toMatchObject({ status: "renewed", businessVerified: true });
    expect(fixture.plugin.inspect).toHaveBeenCalledTimes(2);
    expect(fixture.plugin.renew).toHaveBeenCalledWith({
      preRenew: false,
      withinHours: 24,
    });
    expect(
      await readMaintenanceState(fixture.plugin, { stateDirectory }),
    ).toMatchObject({ locked: false, pendingIntent: false });
  });

  it.each([
    ["identity-unverified", healthy({ identityVerified: false })],
    ["inspection-unavailable", healthy({ status: "unavailable" })],
  ])("fails closed for %s without renewal", async (code, initial) => {
    const { plugin } = fake(initial);
    const outcome = await runCycle(plugin, {
      stateDirectory: await temporary(),
      enabled: true,
      now: 1,
    });
    expect(outcome).toMatchObject({
      status: "needs-attention",
      code,
      businessVerified: false,
    });
    expect(plugin.renew).not.toHaveBeenCalled();
  });

  it("requires explicit pre-renew opt-in and observes extended expiry", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(healthy({ earliestExpiryMs: 100_000 }));
    expect(
      (
        await runCycle(fixture.plugin, {
          stateDirectory,
          enabled: true,
          now: 1,
        })
      ).status,
    ).toBe("healthy");
    expect(fixture.plugin.renew).not.toHaveBeenCalled();
    fixture.plugin.renew = vi.fn(async () => {
      fixture.set(healthy({ earliestExpiryMs: 200_000 }));
      return healthy();
    });
    expect(
      (
        await runCycle(fixture.plugin, {
          stateDirectory,
          enabled: true,
          allowPreRenew: true,
          now: 2,
        })
      ).status,
    ).toBe("renewed");
    expect(fixture.plugin.renew).toHaveBeenCalledWith({
      preRenew: true,
      withinHours: 24,
    });
    // Even if the new deadline remains inside the pre-renew window, do not
    // repeatedly revoke the same observed grant on every scheduled tick.
    expect(
      (
        await runCycle(fixture.plugin, {
          stateDirectory,
          enabled: true,
          allowPreRenew: true,
          now: 3,
        })
      ).status,
    ).toBe("healthy");
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(1);
  });

  it("does not call unchanged expiry a renewal or repeat an uncertain pre-renew", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(healthy({ earliestExpiryMs: 100_000 }));
    fixture.plugin.renew = vi.fn(async () => healthy());
    const options = {
      stateDirectory,
      enabled: true,
      allowPreRenew: true,
      backoffMs: 10,
      now: 1,
    };
    expect(await runCycle(fixture.plugin, options)).toMatchObject({
      status: "needs-attention",
      code: "expiry-not-extended",
      businessVerified: true,
    });
    expect((await runCycle(fixture.plugin, { ...options, now: 11 })).code).toBe(
      "action-outcome-unknown",
    );
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(1);
  });

  it("does not treat a successful page action as successful business authorization", async () => {
    const stateDirectory = await temporary();
    const fixture = fake();
    fixture.plugin.renew = vi.fn(async () => {
      fixture.set(healthy({ businessVerified: false }));
      return healthy();
    });
    expect(
      await runCycle(fixture.plugin, { stateDirectory, enabled: true, now: 1 }),
    ).toMatchObject({
      status: "renewed",
      code: "business-validation-required",
      businessVerified: false,
    });
    expect(
      (await readMaintenanceState(fixture.plugin, { stateDirectory }))
        .pendingIntent,
    ).toBe(false);
  });

  it("continues page-level maintenance across two expiry cycles without claiming business success", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(
      healthy({ businessVerified: false, earliestExpiryMs: 100 }),
    );
    fixture.plugin.renew = vi.fn(async () => {
      fixture.set(
        healthy({
          businessVerified: false,
          earliestExpiryMs:
            vi.mocked(fixture.plugin.renew).mock.calls.length === 1 ? 200 : 300,
        }),
      );
      return healthy({ businessVerified: false });
    });
    const options = { stateDirectory, enabled: true, allowPreRenew: true };
    expect(
      await runCycle(fixture.plugin, { ...options, now: 1 }),
    ).toMatchObject({
      status: "renewed",
      code: "business-validation-required",
      businessVerified: false,
    });
    expect(
      await runCycle(fixture.plugin, { ...options, now: 2 }),
    ).toMatchObject({
      status: "healthy",
      code: "business-validation-required",
      businessVerified: false,
    });
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(1);
    fixture.set(healthy({ businessVerified: false, earliestExpiryMs: 200 }));
    expect(
      await runCycle(fixture.plugin, { ...options, now: 201 }),
    ).toMatchObject({ status: "renewed", businessVerified: false });
    expect(fixture.plugin.renew).toHaveBeenNthCalledWith(2, {
      preRenew: false,
      withinHours: 24,
    });
    expect(
      (await readMaintenanceState(fixture.plugin, { stateDirectory }))
        .pendingIntent,
    ).toBe(false);
  });

  it("pre-renews again in the next lifetime window, not repeatedly within the same hour", async () => {
    const stateDirectory = await temporary();
    const day = 24 * 3_600_000;
    const fixture = fake(
      healthy({ businessVerified: false, earliestExpiryMs: day }),
    );
    fixture.plugin.renew = vi.fn(async () => {
      fixture.set(
        healthy({
          businessVerified: false,
          earliestExpiryMs:
            vi.mocked(fixture.plugin.renew).mock.calls.length === 1
              ? 30 * day
              : 60 * day,
        }),
      );
      return healthy({ businessVerified: false });
    });
    const options = {
      stateDirectory,
      enabled: true,
      allowPreRenew: true,
      withinHours: 24,
    };
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 1 })).status,
    ).toBe("renewed");
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 2 })).status,
    ).toBe("healthy");
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 3_600_000 })).status,
    ).toBe("healthy");
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(1);
    expect(
      (await readMaintenanceState(fixture.plugin, { stateDirectory }))
        .nextPreRenewAtMs,
    ).toBe(29 * day);
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 29 * day })).status,
    ).toBe("renewed");
    expect(fixture.plugin.renew).toHaveBeenNthCalledWith(2, {
      preRenew: true,
      withinHours: 24,
    });
    expect(
      (await readMaintenanceState(fixture.plugin, { stateDirectory }))
        .nextPreRenewAtMs,
    ).toBe(59 * day);
  });

  it("resumes explicitly pending recovery without repeating pre-renew revocation", async () => {
    const stateDirectory = await temporary();
    const fixture = fake(
      healthy({ earliestExpiryMs: 100, businessVerified: false }),
    );
    fixture.plugin.renew = vi
      .fn()
      .mockImplementationOnce(async () => {
        fixture.set(
          healthy({ pendingRecovery: true, businessVerified: false }),
        );
        throw new Error("interrupted");
      })
      .mockImplementationOnce(async () => {
        fixture.set(
          healthy({ earliestExpiryMs: 200, businessVerified: false }),
        );
        return healthy({ businessVerified: false });
      });
    const options = {
      stateDirectory,
      enabled: true,
      allowPreRenew: true,
      backoffMs: 10,
    };
    expect((await runCycle(fixture.plugin, { ...options, now: 1 })).code).toBe(
      "action-outcome-unknown",
    );
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 11 })).status,
    ).toBe("renewed");
    expect(fixture.plugin.renew).toHaveBeenNthCalledWith(1, {
      preRenew: true,
      withinHours: 24,
    });
    expect(fixture.plugin.renew).toHaveBeenNthCalledWith(2, {
      preRenew: false,
      withinHours: 24,
    });
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 12 })).status,
    ).toBe("healthy");
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an action after an uncertain outcome, and accepts verified manual recovery", async () => {
    const stateDirectory = await temporary();
    const fixture = fake();
    fixture.plugin.renew = vi.fn(async () => {
      throw new Error("SECRET provider stdout");
    });
    const options = { stateDirectory, enabled: true, now: 1, backoffMs: 10 };
    expect((await runCycle(fixture.plugin, options)).code).toBe(
      "action-outcome-unknown",
    );
    expect((await runCycle(fixture.plugin, { ...options, now: 11 })).code).toBe(
      "action-outcome-unknown",
    );
    expect(fixture.plugin.renew).toHaveBeenCalledTimes(1);
    fixture.set(healthy());
    expect(
      (await runCycle(fixture.plugin, { ...options, now: 31 })).status,
    ).toBe("healthy");
    const serialized = await readFile(
      join(
        stateDirectory,
        (await readdir(stateDirectory)).find((name) => name.endsWith(".json"))!,
      ),
      "utf8",
    );
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("upstream-untrusted");
  });

  it("backs off explicit failed renewals and bounds attempts", async () => {
    const stateDirectory = await temporary();
    const { plugin } = fake();
    plugin.renew = vi.fn(async () => expired());
    const options = { stateDirectory, enabled: true, backoffMs: 10 };
    expect((await runCycle(plugin, { ...options, now: 0 })).code).toBe(
      "renewal-not-verified",
    );
    const inspected = vi.mocked(plugin.inspect).mock.calls.length;
    expect((await runCycle(plugin, { ...options, now: 1 })).status).toBe(
      "backoff",
    );
    expect(plugin.inspect).toHaveBeenCalledTimes(inspected);
    await runCycle(plugin, { ...options, now: 10 });
    await runCycle(plugin, { ...options, now: 30 });
    expect((await runCycle(plugin, { ...options, now: 70 })).code).toBe(
      "attempt-limit-reached",
    );
    expect(plugin.renew).toHaveBeenCalledTimes(3);
  });

  it("uses a filesystem mutex and keeps identities isolated", async () => {
    const stateDirectory = await temporary();
    let release!: (value: AuthMaintenanceObservation) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { plugin } = fake();
    plugin.inspect = vi.fn(() => {
      entered();
      return new Promise<AuthMaintenanceObservation>((resolve) => {
        release = resolve;
      });
    });
    const cycle = runCycle(plugin, { stateDirectory, enabled: true, now: 1 });
    await ready;
    try {
      expect(
        (await runCycle(plugin, { stateDirectory, enabled: true, now: 1 }))
          .status,
      ).toBe("locked");
      const other = fake(healthy()).plugin;
      other.binding = "b".repeat(64);
      expect(
        (await runCycle(other, { stateDirectory, enabled: true, now: 1 }))
          .status,
      ).toBe("healthy");
    } finally {
      release(healthy());
      await cycle;
    }
  });

  it("never removes a pre-existing/crashed lock", async () => {
    const stateDirectory = await temporary();
    const { plugin } = fake(healthy());
    await runCycle(plugin, { stateDirectory, enabled: true, now: 1 });
    const name = (await readdir(stateDirectory)).find((value) =>
      value.endsWith(".json"),
    )!;
    const lock = join(stateDirectory, name.replace(/\.json$/, ".lock"));
    await mkdir(lock);
    expect(
      (await runCycle(plugin, { stateDirectory, enabled: true, now: 2 })).code,
    ).toBe("lock-held");
    expect((await lstat(lock)).isDirectory()).toBe(true);
  });

  it("fails closed for corrupted state and symbolic state directories", async () => {
    const stateDirectory = await temporary();
    const { plugin } = fake(healthy());
    await runCycle(plugin, { stateDirectory, enabled: true, now: 1 });
    const name = (await readdir(stateDirectory)).find((value) =>
      value.endsWith(".json"),
    )!;
    await writeFile(join(stateDirectory, name), "not-json-SECRET");
    const outcome = await runCycle(plugin, {
      stateDirectory,
      enabled: true,
      now: 2,
    });
    expect(outcome.code).toBe("state-unavailable");
    expect(AUTH_MAINTENANCE_CODES).toContain(outcome.code);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
    const link = join(await temporary(), "state-link");
    await symlink(stateDirectory, link);
    expect(
      (await runCycle(plugin, { stateDirectory: link, enabled: true })).code,
    ).toBe("state-unavailable");
    expect(plugin.renew).not.toHaveBeenCalled();
  });
});
