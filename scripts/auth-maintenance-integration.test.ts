import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMaintenanceMain } from "./auth-maintenance.js";
import { setupAuthMaintenance } from "./setup-auth-maintenance.js";
import { createKeeperMaintenancePlugin } from "./lib/keeper-maintenance-plugin.js";
import type { inspectAuthKeeper, KeeperReport } from "./lib/auth-keeper.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("generated authorization maintenance configuration through the real CLI and engine", () => {
  it("stays disabled by default, recovers once after explicit enable, rechecks and reads status without GUI", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "auth-maintenance-integration-")),
    );
    roots.push(root);
    const keeperRepository = join(root, "keeper-source");
    await mkdir(keeperRepository);
    await writeFile(
      join(keeperRepository, "renew.py"),
      "# fixture only; never invoked\n",
    );
    const python = join(root, "python-fixture");
    await writeFile(python, "# fixture only; never invoked\n", { mode: 0o700 });
    const gateway = join(root, "gateway.env");
    const gatewayText =
      "WECOM_BOT_ID=fixture-only-bot\nWECOM_BOT_SECRET=NEVER-COPY-THIS\n";
    await writeFile(gateway, gatewayText, { mode: 0o600 });
    const input = join(root, "private-input.json");
    await writeFile(
      input,
      JSON.stringify({
        gatewayEnvPath: gateway,
        authorizationUrl:
          "https://work.weixin.qq.com/ai/aiHelper/authorizationList?aibotid=123456&str_aibotid=fixture-only-bot",
        botChatName: "fixture-only-chat",
        targetRows: ["发送消息"],
        keeperRepositoryPath: keeperRepository,
        keeperPythonPath: python,
      }),
      { mode: 0o600 },
    );
    const output = join(root, "generated");
    expect((await setupAuthMaintenance({ input, output })).ok).toBe(true);
    const envFile = join(output, "maintenance.env");
    const stateDirectory = join(output, "state");
    const initialEnvironment = await readFile(envFile, "utf8");

    // Only the external GUI observation/action boundary is fake. The generator,
    // env-file CLI, plugin binding, engine and on-disk state are real implementations.
    let authorized = false;
    const calls: string[] = [];
    const fakeKeeper = vi.fn<typeof inspectAuthKeeper>(async (options) => {
      const mode = options?.mode ?? "doctor";
      calls.push(mode);
      expect(options?.env?.WECOM_BOT_ID).toBe("fixture-only-bot");
      expect(options?.env?.WECOM_BOT_SECRET).toBeUndefined();
      expect(options?.expectedConfigPath).toBe(join(output, "keeper.json"));
      expect(options?.expectedConfigDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(options?.existingWindowOnly).toBe(false);
      if (mode === "renew") {
        expect(options?.withinHours).toBe(24);
        authorized = true;
      } else expect(mode).toBe("inspect");
      const now = Date.now();
      const report: KeeperReport = {
        schemaVersion: 1,
        event: "auth_keeper",
        mode,
        ok: authorized,
        status: authorized
          ? "page-authorizations-verified"
          : "permissions-unhealthy",
        scope: "optional-cli-capabilities",
        targetRowCount: 1,
        identity: "page-verified",
        businessApi: "not-verified",
        cliCredentialIdentity: "not-verified",
        transport: "not-checked",
        observation: {
          observedAtMs: now,
          earliestExpiryMs: authorized ? now + 7 * 86_400_000 : now - 60_000,
          expiredCount: authorized ? 0 : 1,
          pendingRecovery: false,
        },
      };
      return report;
    });
    const createPlugin = vi.fn<typeof createKeeperMaintenancePlugin>(
      async ({ env }) => {
        expect(env.WECOM_AUTH_MAINTENANCE_STATE_DIR).toBe(stateDirectory);
        expect(env.WECOM_AUTH_MAINTENANCE_PRE_RENEW).toBe("false");
        return createKeeperMaintenancePlugin({ env, inspect: fakeKeeper });
      },
    );
    const events: unknown[] = [];
    const dependencies = {
      env: {},
      createPlugin,
      emit: (event: unknown) => events.push(event),
    };

    expect(
      await authMaintenanceMain(["once", "--env-file", envFile], dependencies),
    ).toBe(0);
    expect(createPlugin).not.toHaveBeenCalled();
    expect(fakeKeeper).not.toHaveBeenCalled();
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      status: "disabled",
      businessVerified: false,
    });

    expect(
      await authMaintenanceMain(
        ["status", "--env-file", envFile],
        dependencies,
      ),
    ).toBe(0);
    expect(events.at(-1)).toMatchObject({
      event: "auth_maintenance_status",
      enabled: false,
      status: "absent",
      businessVerified: false,
    });
    expect(fakeKeeper).not.toHaveBeenCalled();
    expect(await readdir(stateDirectory)).toEqual([]);

    // Explicit enable applies only to the test's newly generated fixture file.
    await writeFile(
      envFile,
      initialEnvironment.replace(
        "WECOM_AUTH_MAINTENANCE_ENABLED=false",
        "WECOM_AUTH_MAINTENANCE_ENABLED=true",
      ),
    );
    expect(
      await authMaintenanceMain(["once", "--env-file", envFile], dependencies),
    ).toBe(0);
    expect(calls).toEqual(["inspect", "renew", "inspect"]);
    expect(events.at(-1)).toMatchObject({
      status: "renewed",
      code: "business-validation-required",
      businessVerified: false,
    });
    const files = await readdir(stateDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const stateFile = join(stateDirectory, files[0]!);
    const persisted = await readFile(stateFile, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      attempts: 0,
      failures: 0,
    });
    expect(JSON.parse(persisted).intent).toBeUndefined();
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);

    // A new CLI invocation rebuilds the same binding and does not renew again.
    expect(
      await authMaintenanceMain(["once", "--env-file", envFile], dependencies),
    ).toBe(0);
    expect(calls).toEqual(["inspect", "renew", "inspect", "inspect"]);
    expect(events.at(-1)).toMatchObject({
      status: "healthy",
      businessVerified: false,
    });
    const beforeStatus = await readFile(stateFile, "utf8");
    expect(
      await authMaintenanceMain(
        ["status", "--env-file", envFile],
        dependencies,
      ),
    ).toBe(0);
    expect(calls).toEqual(["inspect", "renew", "inspect", "inspect"]);
    expect(events.at(-1)).toMatchObject({
      event: "auth_maintenance_status",
      enabled: true,
      status: "present",
      pendingIntent: false,
      businessVerified: false,
    });
    expect(await readFile(stateFile, "utf8")).toBe(beforeStatus);
    expect(await readFile(gateway, "utf8")).toBe(gatewayText);
    expect(JSON.stringify(events) + persisted).not.toMatch(
      /fixture-only|NEVER-COPY-THIS|https:|123456/,
    );
  });
});
