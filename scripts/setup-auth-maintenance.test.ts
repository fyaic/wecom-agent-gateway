import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authMaintenanceSetupMain,
  setupAuthMaintenance,
} from "./setup-auth-maintenance.js";

const roots: string[] = [];
const identity = "fixture-gateway-identity";
const officialUrl = `https://work.weixin.qq.com/ai/aiHelper/authorizationList?aibotid=123456&str_aibotid=${identity}&from=chat`;
async function fixture(changes: Record<string, unknown> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "auth-setup-test-")),
  );
  roots.push(root);
  const keeper = join(root, "keeper");
  await mkdir(keeper);
  await writeFile(join(keeper, "renew.py"), "# fixture; never execute\n");
  const python = join(root, "fake-python");
  await writeFile(python, "# fixture; never execute\n", { mode: 0o700 });
  const gatewayEnv = join(root, "gateway.env");
  const env = `WECOM_BOT_ID=${identity}\nWECOM_BOT_SECRET=PRIVATE-NEVER-COPY\nOTHER_KEY=PRIVATE-NEVER-COPY\n`;
  await writeFile(gatewayEnv, env, { mode: 0o600 });
  const value = {
    gatewayEnvPath: gatewayEnv,
    authorizationUrl: officialUrl,
    botChatName: "fixture-private-chat",
    targetRows: ["发送消息", "搜索与获取文档内容"],
    keeperRepositoryPath: keeper,
    keeperPythonPath: python,
    ...changes,
  };
  const input = join(root, "input.json");
  await writeFile(input, JSON.stringify(value), { mode: 0o600 });
  return {
    root,
    keeper,
    python,
    gatewayEnv,
    env,
    value,
    input,
    output: join(root, "new-config"),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private auth maintenance configuration generator", () => {
  it("creates user-scoped private files with automation disabled and without copying secrets", async () => {
    const f = await fixture();
    const source = await readFile(f.input, "utf8");
    const result = await setupAuthMaintenance(f);
    expect(result).toEqual({
      event: "auth_maintenance_setup",
      ok: true,
      status: "configuration-created-disabled",
      targetRowCount: 2,
      maintenanceEnabled: false,
    });
    const keeperText = await readFile(join(f.output, "keeper.json"), "utf8");
    const envText = await readFile(join(f.output, "maintenance.env"), "utf8");
    expect(JSON.parse(keeperText)).toMatchObject({
      aibotid: "123456",
      str_aibotid: identity,
      bot_chat_name: f.value.botChatName,
      target_rows: f.value.targetRows,
      bridge_send_link: false,
      bridge_monitor: false,
      state_file: join(f.output, "state", "keeper.json"),
      log_file: join(f.output, "state", "keeper.log"),
    });
    expect(parseEnv(envText)).toEqual({
      WECOM_BOT_ID: identity,
      WECOM_AUTH_KEEPER_DIR: f.keeper,
      WECOM_AUTH_KEEPER_CONFIG: join(f.output, "keeper.json"),
      WECOM_AUTH_KEEPER_PYTHON: f.python,
      WECOM_AUTH_MAINTENANCE_ENABLED: "false",
      WECOM_AUTH_MAINTENANCE_PRE_RENEW: "false",
      WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY: "false",
      WECOM_AUTH_MAINTENANCE_STATE_DIR: join(f.output, "state"),
      WECOM_AUTH_MAINTENANCE_INTERVAL_MS: "3600000",
      WECOM_AUTH_KEEPER_WITHIN_HOURS: "24",
    });
    expect(keeperText + envText).not.toContain("PRIVATE-NEVER-COPY");
    expect(keeperText + envText).not.toContain(officialUrl);
    expect(envText).not.toContain("WECOM_BOT_SECRET");
    for (const file of ["keeper.json", "maintenance.env"])
      expect((await stat(join(f.output, file))).mode & 0o777).toBe(0o600);
    for (const dir of [f.output, join(f.output, "state")])
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readFile(f.gatewayEnv, "utf8")).toBe(f.env);
    expect(await readFile(f.input, "utf8")).toBe(source);
    expect(await readFile(join(f.keeper, "renew.py"), "utf8")).toBe(
      "# fixture; never execute\n",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-|PRIVATE|https:|123456/,
    );
  });

  it.each([
    "http://work.weixin.qq.com/ai/aiHelper/authorizationList?aibotid=1&str_aibotid=x",
    officialUrl.replace(
      "work.weixin.qq.com",
      "work.weixin.qq.com.evil.invalid",
    ),
    officialUrl.replace(
      "work.weixin.qq.com",
      ["user:password", "work.weixin.qq.com"].join("@"),
    ),
    officialUrl.replace("work.weixin.qq.com", "work.weixin.qq.com:444"),
    officialUrl.replace("/authorizationList?", "/authorizationList/extra?"),
    officialUrl.replace("/ai/", "/other/../ai/"),
    `${officialUrl}#private`,
    `${officialUrl}&aibotid=123456`,
    `${officialUrl}&str_aibotid=${identity}`,
    officialUrl.replace("aibotid=123456", "aibotid="),
    officialUrl.replace("aibotid=123456", "aibotid=not-numeric"),
    officialUrl.replace(`str_aibotid=${identity}`, "str_aibotid=another-bot"),
    "",
    "not-a-url",
  ])(
    "rejects invalid or different-identity authorization links without creating output",
    async (authorizationUrl) => {
      const f = await fixture({ authorizationUrl });
      const result = await setupAuthMaintenance(f);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(
        authorizationUrl || "no-url-marker",
      );
      await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    [],
    ["*"],
    ["发送消息", "发送消息"],
    ["新权限"],
    [" 发送消息"],
    [123],
    null,
  ])(
    "requires an explicit nonempty known capability allowlist %j",
    async (targetRows) => {
      const f = await fixture({ targetRows });
      expect((await setupAuthMaintenance(f)).status).toBe(
        "invalid-capability-allowlist",
      );
      await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["gatewayEnvPath", "keeperRepositoryPath", "keeperPythonPath"])(
    "rejects empty/relative %s",
    async (key) => {
      for (const value of ["", "relative", " "]) {
        const f = await fixture({ [key]: value });
        expect((await setupAuthMaintenance(f)).status).toBe(
          "absolute-paths-required",
        );
      }
    },
  );

  it.each(["directory", "file", "symlink", "dangling-symlink"])(
    "refuses existing %s output and preserves it",
    async (kind) => {
      const f = await fixture();
      if (kind === "directory") await mkdir(f.output);
      else if (kind === "file") await writeFile(f.output, "preserve");
      else
        await symlink(
          kind === "symlink" ? f.keeper : join(f.root, "missing"),
          f.output,
        );
      const before = await lstat(f.output);
      expect((await setupAuthMaintenance(f)).status).toBe(
        "output-already-exists",
      );
      expect((await lstat(f.output)).ino).toBe(before.ino);
      if (kind === "file")
        expect(await readFile(f.output, "utf8")).toBe("preserve");
    },
  );

  it("refuses output within the existing Keeper repository, including alias paths", async () => {
    const f = await fixture();
    const alias = join(f.root, "keeper-alias");
    await symlink(f.keeper, alias);
    for (const output of [join(f.keeper, "new"), join(alias, "..private")])
      expect((await setupAuthMaintenance({ ...f, output })).status).toBe(
        "output-inside-keeper-repository",
      );
  });

  it("requires private input and refuses unknown fields or missing Gateway identity", async () => {
    const f = await fixture();
    await chmod(f.input, 0o644);
    expect((await setupAuthMaintenance(f)).status).toBe("input-not-private");
    await chmod(f.input, 0o600);
    await writeFile(
      f.input,
      JSON.stringify({ ...f.value, secret: "PRIVATE-NEVER-COPY" }),
    );
    expect((await setupAuthMaintenance(f)).status).toBe("invalid-input-fields");
    await writeFile(f.input, JSON.stringify(f.value));
    await writeFile(f.gatewayEnv, "WECOM_BOT_SECRET=PRIVATE-NEVER-COPY\n");
    expect((await setupAuthMaintenance(f)).status).toBe(
      "gateway-identity-missing",
    );
  });

  it("prints only fixed safe outcomes for success, identity failure, malformed input and bad arguments", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await authMaintenanceSetupMain([
        "--input",
        f.input,
        "--output",
        f.output,
      ]),
    ).toBe(0);
    await writeFile(
      f.input,
      JSON.stringify({
        ...f.value,
        authorizationUrl: officialUrl.replace(identity, "private-wrong-bot"),
      }),
    );
    expect(
      await authMaintenanceSetupMain([
        "--input",
        f.input,
        "--output",
        join(f.root, "other"),
      ]),
    ).toBe(2);
    await writeFile(f.input, "private-invalid-json");
    expect(
      await authMaintenanceSetupMain([
        "--input",
        f.input,
        "--output",
        join(f.root, "other"),
      ]),
    ).toBe(2);
    expect(
      await authMaintenanceSetupMain(["--authorizationUrl", officialUrl]),
    ).toBe(2);
    expect(
      await authMaintenanceSetupMain(["--input", "", "--output", ""]),
    ).toBe(2);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toMatch(
      /private-wrong|private-invalid|PRIVATE-NEVER-COPY|123456|https:|fixture-gateway/,
    );
    expect(output).not.toContain(f.root);
  });
});
