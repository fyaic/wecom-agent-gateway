import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authKeeperMain } from "../auth-keeper.js";
import {
  inspectAuthKeeper,
  keeperChildEnvironment,
  runKeeperProcess,
  type KeeperInvocation,
  type KeeperMode,
  type KeeperProcessResult,
} from "./auth-keeper.js";

const directories: string[] = [];
const doctorPayload = {
  ok: true,
  mode: "doctor",
  checks: {
    macos: true,
    AppKit: true,
    Quartz: true,
    ApplicationServices: true,
    wecom_cli: true,
  },
  gui_access: "not_checked",
};
const guiPayload = (mode = "renew") => ({
  ok: true,
  mode,
  rows: { 测试权限: { status: "authorized", expiry: "2099-01-01T12:00" } },
  pending_recovery: false,
});

async function fixture(changes: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "keeper-wrapper-test-"));
  directories.push(directory);
  const configPath = join(directory, "private.json");
  const config = {
    aibotid: "private-numeric-bot",
    str_aibotid: "private-gateway-bot",
    bot_chat_name: "private-chat-name",
    target_rows: ["测试权限"],
    bridge_send_link: false,
    bridge_monitor: false,
    venv_python: "/fake/python",
    state_file: "state.json",
    log_file: "log.jsonl",
    ...changes,
  };
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    WECOM_BOT_ID: "private-gateway-bot",
    WECOM_AUTH_KEEPER_DIR: directory,
    WECOM_AUTH_KEEPER_CONFIG: configPath,
  };
  return {
    directory,
    canonicalDirectory: await realpath(directory),
    configPath,
    config,
    env,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("optional auth keeper integration", () => {
  it("defaults to local doctor, snapshots the matched identity and cleans its private snapshot", async () => {
    const f = await fixture();
    let snapshotPath = "";
    const run = vi.fn(async (invocation: KeeperInvocation) => {
      expect(invocation.args[3]).toBe("--doctor");
      expect(invocation.args).not.toContain("--existing-window");
      expect(invocation.timeoutMs).toBe(15_000);
      snapshotPath = invocation.args[2];
      expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      expect(snapshot.str_aibotid).toBe(f.env.WECOM_BOT_ID);
      expect(snapshot.state_file).toBe(
        join(f.canonicalDirectory, "state.json"),
      );
      // Rewriting original config cannot change the child process's target.
      await writeFile(
        f.configPath,
        JSON.stringify({ ...f.config, str_aibotid: "another-bot" }),
      );
      expect(JSON.parse(await readFile(snapshotPath, "utf8")).str_aibotid).toBe(
        f.env.WECOM_BOT_ID,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ...doctorPayload, secret: "NEVER-OUTPUT" }),
      };
    });
    const result = await inspectAuthKeeper({
      env: f.env,
      platform: "darwin",
      run,
    });
    expect(result).toMatchObject({
      ok: true,
      status: "local-prerequisites-ready",
      businessApi: "not-verified",
      cliCredentialIdentity: "not-verified",
      transport: "not-checked",
      identity: "configuration-matched",
      targetRowCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|NEVER-OUTPUT/);
    await expect(access(snapshotPath)).rejects.toThrow();
  });

  it.each(["inspect", "renew"] as KeeperMode[])(
    "%s is explicit, existing-window only, and never claims business recovery",
    async (mode) => {
      const f = await fixture();
      const run = vi.fn(async (invocation: KeeperInvocation) => {
        expect(invocation.args.slice(3)).toEqual([
          mode === "renew" ? "--renew" : "--check",
          "--existing-window",
        ]);
        expect(invocation.args).not.toContain("--pre-renew");
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            guiPayload(mode === "renew" ? "renew" : "check"),
          ),
        };
      });
      const result = await inspectAuthKeeper({
        mode,
        env: f.env,
        platform: "darwin",
        run,
      });
      expect(result).toMatchObject({
        ok: true,
        status: "page-authorizations-verified",
        identity: "page-verified",
        businessApi: "not-verified",
        cliCredentialIdentity: "not-verified",
      });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "   "])(
    "treats blank Python override as unset",
    async (pythonOverride) => {
      const f = await fixture();
      const run = vi.fn(async (invocation: KeeperInvocation) => {
        expect(invocation.command).toBe(f.config.venv_python);
        return { exitCode: 0, stdout: JSON.stringify(doctorPayload) };
      });
      expect(
        (
          await inspectAuthKeeper({
            env: { ...f.env, WECOM_AUTH_KEEPER_PYTHON: pythonOverride },
            platform: "darwin",
            run,
          })
        ).ok,
      ).toBe(true);
    },
  );

  it.each([
    { str_aibotid: "different-bot" },
    { aibotid: "" },
    { target_rows: [] },
    { target_rows: ["same", "same"] },
    { target_rows: null },
    { bridge_send_link: true },
    { bridge_monitor: true },
    { bridge_monitor: undefined },
    { venv_python: "python3" },
    { state_file: "log.jsonl" },
    { state_file: "private.json" },
    { log_file: "private.json" },
  ])(
    "fails closed before launching unsafe/mismatched config %j",
    async (changes) => {
      const f = await fixture(changes);
      const run = vi.fn();
      expect(
        (
          await inspectAuthKeeper({
            mode: "renew",
            env: f.env,
            platform: "darwin",
            run,
          })
        ).ok,
      ).toBe(false);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("does not launch for missing config, absent bot identity or unsupported platforms", async () => {
    const f = await fixture();
    const run = vi.fn();
    expect(
      (await inspectAuthKeeper({ env: {}, platform: "darwin", run })).status,
    ).toBe("not-configured");
    expect(
      (await inspectAuthKeeper({ env: f.env, platform: "linux", run })).status,
    ).toBe("unsupported-platform");
    expect(
      (
        await inspectAuthKeeper({
          env: { ...f.env, WECOM_BOT_ID: undefined },
          platform: "darwin",
          run,
        })
      ).ok,
    ).toBe(false);
    await writeFile(f.configPath, "invalid secret JSON");
    expect(
      (await inspectAuthKeeper({ env: f.env, platform: "darwin", run })).ok,
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["config-link", "parent-link"])(
    "rejects original configuration collisions through %s",
    async (kind) => {
      const f = await fixture({ state_file: "private.json" });
      const run = vi.fn();
      let configPath: string;
      if (kind === "config-link") {
        configPath = join(f.directory, "alias.json");
        await symlink(f.configPath, configPath);
      } else {
        const parentLink = join(f.directory, "alias");
        await symlink(f.directory, parentLink);
        configPath = join(parentLink, "private.json");
        await writeFile(
          f.configPath,
          JSON.stringify({ ...f.config, state_file: f.configPath }),
        );
      }
      const result = await inspectAuthKeeper({
        env: { ...f.env, WECOM_AUTH_KEEPER_CONFIG: configPath },
        mode: "renew",
        platform: "darwin",
        run,
      });
      expect(result.status).toBe("unsafe-configuration");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects not-yet-created state/log collisions below a symlinked directory", async () => {
    const f = await fixture();
    const alias = join(f.directory, "alias");
    await symlink(f.directory, alias);
    await writeFile(
      f.configPath,
      JSON.stringify({
        ...f.config,
        state_file: join(f.directory, "future", "state.json"),
        log_file: join(alias, "future", "state.json"),
      }),
    );
    const run = vi.fn();
    expect(
      (await inspectAuthKeeper({ env: f.env, platform: "darwin", run })).status,
    ).toBe("unsafe-configuration");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves Keeper's real-config-relative paths through a cross-directory symlink", async () => {
    const f = await fixture({ wecom_cli: "bin/wecom-cli" });
    const aliasDirectory = await mkdtemp(
      join(tmpdir(), "keeper-config-alias-"),
    );
    directories.push(aliasDirectory);
    const aliasPath = join(aliasDirectory, "keeper.json");
    await symlink(f.configPath, aliasPath);
    const run = vi.fn(async (invocation: KeeperInvocation) => {
      const snapshot = JSON.parse(await readFile(invocation.args[2], "utf8"));
      expect(snapshot.state_file).toBe(
        join(f.canonicalDirectory, "state.json"),
      );
      expect(snapshot.log_file).toBe(join(f.canonicalDirectory, "log.jsonl"));
      expect(snapshot.wecom_cli).toBe(
        join(f.canonicalDirectory, "bin/wecom-cli"),
      );
      return { exitCode: 0, stdout: JSON.stringify(doctorPayload) };
    });
    const result = await inspectAuthKeeper({
      env: { ...f.env, WECOM_AUTH_KEEPER_CONFIG: aliasPath },
      platform: "darwin",
      run,
    });
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    [4, "private-error", "keeper-busy"],
    [3, "private-error", "keeper-prerequisites-failed"],
    [
      3,
      "accessibility_permission_unavailable",
      "accessibility-permission-unavailable",
    ],
    [3, "wecom_not_running", "wecom-not-running"],
    [2, "wecom_window_unavailable", "wecom-window-unavailable"],
    [2, "wecom_multiple_instances", "wecom-multiple-instances"],
    [2, "page_not_open", "target-page-not-open"],
    [2, "link_not_visible", "target-link-not-visible"],
    [2, "identity_unverified", "target-page-unverified"],
    [2, "ambiguous_window", "target-page-ambiguous"],
    [2, "rows_incomplete", "target-page-incomplete"],
    [2, "tree_incomplete", "target-page-incomplete"],
    [2, "pending_mismatch", "recovery-target-mismatch"],
    [2, "permissions_not_healthy", "permissions-unhealthy"],
    [2, "private-error", "keeper-failed"],
  ])(
    "keeps only fixed actionable failure labels",
    async (exitCode, error, status) => {
      const f = await fixture();
      const result = await inspectAuthKeeper({
        env: f.env,
        platform: "darwin",
        run: async () => ({
          exitCode: Number(exitCode),
          stdout: JSON.stringify({
            ok: false,
            error,
            message: "private-error-path",
          }),
        }),
      });
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("private-error");
    },
  );

  it.each([
    { exitCode: null, stdout: "secret", failure: "timeout" },
    { exitCode: 4, stdout: JSON.stringify(doctorPayload) },
    { exitCode: 0, stdout: "secret non-json" },
    { exitCode: 0, stdout: JSON.stringify({ ok: true, mode: "doctor" }) },
    { exitCode: 0, stdout: JSON.stringify({ ...doctorPayload, checks: {} }) },
    { exitCode: 0, stdout: JSON.stringify({ ...doctorPayload, ok: false }) },
  ] as KeeperProcessResult[])(
    "rejects process/JSON errors without leaking or retrying",
    async (child) => {
      const f = await fixture();
      const run = vi.fn(async () => child);
      const result = await inspectAuthKeeper({
        env: f.env,
        platform: "darwin",
        run,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { ...guiPayload(), pending_recovery: true },
    { ...guiPayload(), rows: {} },
    { ...guiPayload(), mode: "pre-renew" },
    {
      ...guiPayload(),
      rows: { 测试权限: { status: "authorized", expiry: "2000-01-01T12:00" } },
    },
    {
      ...guiPayload(),
      rows: { 测试权限: { status: "expired", expiry: "2099-01-01T12:00" } },
    },
  ])(
    "rejects incomplete, stale or mismatched GUI evidence",
    async (payload) => {
      const f = await fixture();
      const result = await inspectAuthKeeper({
        mode: "renew",
        env: f.env,
        platform: "darwin",
        run: async () => ({ exitCode: 0, stdout: JSON.stringify(payload) }),
      });
      expect(result).toMatchObject({
        ok: false,
        status: "invalid-response",
        businessApi: "not-verified",
      });
    },
  );

  it("rejects unknown arguments without invoking any GUI mode", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await authKeeperMain(["--pre-renew"])).toBe(2);
    expect(await authKeeperMain(["renew", "--pre-renew"])).toBe(2);
    expect(await authKeeperMain(["check"])).toBe(2);
    expect(output).toHaveBeenCalledTimes(3);
  });
});

describe("immutable maintenance provider binding", () => {
  async function binding(configPath: string) {
    return {
      expectedConfigPath: await realpath(configPath),
      expectedConfigDigest: createHash("sha256")
        .update(await readFile(configPath))
        .digest("hex"),
    };
  }

  it("accepts the expected canonical path and exact bytes, then freezes the verified configuration", async () => {
    const f = await fixture();
    const expected = await binding(f.configPath);
    let snapshotRows: unknown;
    const result = await inspectAuthKeeper({
      mode: "renew",
      env: f.env,
      platform: "darwin",
      ...expected,
      run: async (invocation) => {
        await writeFile(
          f.configPath,
          JSON.stringify({ ...f.config, target_rows: ["expanded-scope"] }),
        );
        snapshotRows = JSON.parse(
          await readFile(invocation.args[2], "utf8"),
        ).target_rows;
        return { exitCode: 0, stdout: JSON.stringify(guiPayload()) };
      },
    });
    expect(result.ok).toBe(true);
    expect(snapshotRows).toEqual(f.config.target_rows);
  });

  it("rejects same-Bot scope changes after a provider has captured its binding", async () => {
    const f = await fixture();
    const expected = await binding(f.configPath);
    await writeFile(
      f.configPath,
      JSON.stringify({ ...f.config, target_rows: ["expanded-scope"] }),
    );
    const run = vi.fn();
    const result = await inspectAuthKeeper({
      mode: "renew",
      env: f.env,
      platform: "darwin",
      ...expected,
      run,
    });
    expect(result).toMatchObject({
      ok: false,
      status: "configuration-changed",
      identity: "not-verified",
    });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-|expanded-scope/);
  });

  it("rejects a config symlink retargeted to identical bytes under another parent", async () => {
    const f = await fixture();
    const other = await fixture();
    const alias = join(f.directory, "alias.json");
    await symlink(f.configPath, alias);
    const expected = await binding(alias);
    await rm(alias);
    await symlink(other.configPath, alias);
    const run = vi.fn();
    const result = await inspectAuthKeeper({
      mode: "renew",
      env: { ...f.env, WECOM_AUTH_KEEPER_CONFIG: alias },
      platform: "darwin",
      ...expected,
      run,
    });
    expect(result.status).toBe("configuration-changed");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { expectedConfigDigest: "a".repeat(64) },
    { expectedConfigPath: "/private/config.json" },
    {
      expectedConfigPath: "relative.json",
      expectedConfigDigest: "a".repeat(64),
    },
    {
      expectedConfigPath: "/private/config.json",
      expectedConfigDigest: "not-a-sha256",
    },
  ])("rejects partial or malformed immutable bindings", async (expected) => {
    const f = await fixture();
    const run = vi.fn();
    const result = await inspectAuthKeeper({
      mode: "renew",
      env: f.env,
      platform: "darwin",
      ...expected,
      run,
    });
    expect(result.status).toBe("invalid-configuration");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("explicit pre-renew and sanitized page observations", () => {
  const now = Date.parse("2026-10-08T12:00:00");
  const expiredPage = (overrides: Record<string, unknown> = {}) => ({
    ok: false,
    error: "permissions_not_healthy",
    mode: "check",
    rows: {
      测试权限: { status: "expired", expiry: null },
    },
    pending_recovery: false,
    ...overrides,
  });

  it.each([undefined, 0, 0.5, 24, 168])(
    "passes an explicit bounded pre-renew horizon %s",
    async (withinHours) => {
      const f = await fixture();
      let invocation: KeeperInvocation | undefined;
      const result = await inspectAuthKeeper({
        mode: "pre-renew",
        withinHours,
        env: f.env,
        platform: "darwin",
        run: async (value) => {
          invocation = value;
          return {
            exitCode: 0,
            stdout: JSON.stringify(guiPayload("pre-renew")),
          };
        },
      });
      expect(result.ok).toBe(true);
      expect(invocation?.args.slice(3)).toEqual([
        "--pre-renew",
        "--existing-window",
        "--within-hours",
        String(withinHours ?? 24),
      ]);
      expect(invocation?.timeoutMs).toBe(240_000);
    },
  );

  it.each([-0.01, 168.01, NaN, Infinity, -Infinity, "24", null])(
    "rejects invalid renewal horizon %s before a child starts",
    async (withinHours) => {
      const f = await fixture();
      const run = vi.fn();
      const result = await inspectAuthKeeper({
        mode: "pre-renew",
        withinHours: withinHours as number,
        env: f.env,
        platform: "darwin",
        run,
      });
      expect(result).toMatchObject({
        ok: false,
        status: "invalid-configuration",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(["inspect", "renew"] as KeeperMode[])(
    "only explicitly permits Keeper visible-link navigation for %s",
    async (mode) => {
      const f = await fixture();
      let invocation: KeeperInvocation | undefined;
      const result = await inspectAuthKeeper({
        mode,
        existingWindowOnly: false,
        env: f.env,
        platform: "darwin",
        run: async (value) => {
          invocation = value;
          const config = JSON.parse(await readFile(value.args[2], "utf8"));
          expect(config.bridge_send_link).toBe(false);
          expect(config.bridge_monitor).toBe(false);
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              guiPayload(mode === "inspect" ? "check" : mode),
            ),
          };
        },
      });
      expect(result.ok).toBe(true);
      expect(invocation?.args.slice(3)).toEqual([
        mode === "inspect" ? "--check" : "--renew",
      ]);
    },
  );

  it("does not pretend pre-renew supports navigation when the Keeper requires an existing page", async () => {
    const f = await fixture();
    const run = vi.fn();
    const result = await inspectAuthKeeper({
      mode: "pre-renew",
      existingWindowOnly: false,
      env: f.env,
      platform: "darwin",
      run,
    });
    expect(result.status).toBe("invalid-configuration");
    expect(run).not.toHaveBeenCalled();
  });

  it("aggregates healthy expiry without exposing capability names or IDs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = await fixture({ target_rows: ["private-one", "private-two"] });
    const result = await inspectAuthKeeper({
      mode: "inspect",
      env: f.env,
      platform: "darwin",
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          mode: "check",
          pending_recovery: false,
          privateKey: "DO-NOT-LEAK",
          rows: {
            "private-one": { status: "authorized", expiry: "2026-10-10T12:00" },
            "private-two": { status: "authorized", expiry: "2026-10-09T12:00" },
          },
        }),
      }),
    });
    expect(result.observation).toEqual({
      observedAtMs: now,
      earliestExpiryMs: Date.parse("2026-10-09T12:00"),
      expiredCount: 0,
      pendingRecovery: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|DO-NOT-LEAK/);
  });

  it.each(["inspect", "renew", "pre-renew"] as KeeperMode[])(
    "preserves valid unhealthy page evidence for %s while failing the operation",
    async (mode) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const f = await fixture({
        target_rows: ["测试权限", "另一权限", "已授权权限"],
      });
      const result = await inspectAuthKeeper({
        mode,
        env: f.env,
        platform: "darwin",
        run: async () => ({
          exitCode: 2,
          failure: "process-failed",
          stdout: JSON.stringify(
            expiredPage({
              mode: mode === "inspect" ? "check" : mode,
              pending_recovery: true,
              rows: {
                测试权限: { status: "expired", expiry: null },
                另一权限: { status: "expired", expiry: "2026-10-07T12:00" },
                已授权权限: {
                  status: "authorized",
                  expiry: "2026-10-09T12:00",
                },
              },
            }),
          ),
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        status: "permissions-unhealthy",
        identity: "page-verified",
        businessApi: "not-verified",
        cliCredentialIdentity: "not-verified",
        observation: {
          observedAtMs: now,
          earliestExpiryMs: Date.parse("2026-10-07T12:00"),
          expiredCount: 2,
          pendingRecovery: true,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /测试权限|另一权限|已授权权限|private-/,
      );
    },
  );

  it("represents missing expiry as null only for a fully verified expired page", async () => {
    const f = await fixture();
    const result = await inspectAuthKeeper({
      mode: "inspect",
      env: f.env,
      platform: "darwin",
      run: async () => ({ exitCode: 2, stdout: JSON.stringify(expiredPage()) }),
    });
    expect(result.observation).toMatchObject({
      earliestExpiryMs: null,
      expiredCount: 1,
      pendingRecovery: false,
    });
  });

  it("preserves a verified pending recovery when all page rows are authorized", async () => {
    const f = await fixture();
    const result = await inspectAuthKeeper({
      mode: "inspect",
      env: f.env,
      platform: "darwin",
      run: async () => ({
        exitCode: 2,
        stdout: JSON.stringify(
          expiredPage({ rows: guiPayload().rows, pending_recovery: true }),
        ),
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      observation: { expiredCount: 0, pendingRecovery: true },
    });
  });

  it.each([
    { rows: {} },
    { rows: { 测试权限: { status: "unknown", expiry: null } } },
    { rows: { 测试权限: { status: "expired", expiry: "2099-01-01T12:00" } } },
    { rows: { 测试权限: { status: "authorized", expiry: null } } },
    {
      rows: { 测试权限: { status: "authorized", expiry: "2000-01-01T12:00" } },
    },
    { rows: { 测试权限: { status: "expired", expiry: "2026-02-30T12:00" } } },
    { rows: { 测试权限: { status: "expired", expiry: "private-non-date" } } },
    { rows: { 测试权限: { status: "expired" } } },
    {
      rows: {
        测试权限: { status: "expired", expiry: null },
        extra: { status: "expired", expiry: null },
      },
    },
    { rows: { different: { status: "expired", expiry: null } } },
    { pending_recovery: "true" },
    { pending_recovery: undefined },
    { mode: "renew" },
    { rows: guiPayload().rows },
  ])(
    "never exposes observations from malformed or contradictory unhealthy rows",
    async (changes) => {
      const f = await fixture();
      const result = await inspectAuthKeeper({
        mode: "inspect",
        env: f.env,
        platform: "darwin",
        run: async () => ({
          exitCode: 2,
          stdout: JSON.stringify(expiredPage(changes)),
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        status: "invalid-response",
        identity: "configuration-matched",
      });
      expect(result.observation).toBeUndefined();
    },
  );

  it.each([
    { exitCode: 0, stdout: JSON.stringify(expiredPage()) },
    { exitCode: 3, stdout: JSON.stringify(expiredPage()) },
    { exitCode: 2, failure: "timeout", stdout: JSON.stringify(expiredPage()) },
    {
      exitCode: 2,
      stdout: JSON.stringify(expiredPage({ error: "other-error" })),
    },
    { exitCode: 2, stdout: JSON.stringify(expiredPage({ ok: true })) },
  ] as KeeperProcessResult[])(
    "does not infer page evidence from wrong process outcomes",
    async (child) => {
      const f = await fixture();
      const result = await inspectAuthKeeper({
        mode: "inspect",
        env: f.env,
        platform: "darwin",
        run: async () => child,
      });
      expect(result.ok).toBe(false);
      expect(result.observation).toBeUndefined();
    },
  );
});

describe("bounded keeper child process", () => {
  it("passes only system environment, not gateway/model credentials or injection settings", () => {
    expect(
      keeperChildEnvironment({
        PATH: "/bin",
        HOME: "/test-home",
        WECOM_BOT_SECRET: "test-sensitive",
        ANTHROPIC_API_KEY: "test-sensitive",
        PYTHONPATH: "/untrusted",
        NODE_OPTIONS: "--require=untrusted",
        UNKNOWN_NEW_PROVIDER_KEY: "test-sensitive",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/test-home" });
  });

  it("kills a hung fake child and returns only a fixed timeout code", async () => {
    const child = await runKeeperProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeoutMs: 50,
    });
    expect(child.failure).toBe("timeout");
  });

  it("bounds child output and fails without hanging", async () => {
    const child = await runKeeperProcess({
      command: process.execPath,
      args: ["-e", "console.log('x'.repeat(200000))"],
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    expect(child.failure).toBeDefined();
  });
});
