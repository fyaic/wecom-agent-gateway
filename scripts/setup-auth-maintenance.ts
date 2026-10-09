import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const capabilityLabels = new Set([
  "发送消息",
  "发送邮件",
  "搜索与获取邮件内容",
  "新建与编辑文档",
  "搜索与获取文档内容",
  "新建与跟进待办",
  "新建与管理日程",
  "预约与更新会议",
  "搜索与获取会议信息",
  "上传与更新微盘文件",
  "搜索与获取微盘文件内容",
  "搜索企业成员",
  "获取对话用户信息",
]);
const inputKeys = [
  "gatewayEnvPath",
  "authorizationUrl",
  "botChatName",
  "targetRows",
  "keeperRepositoryPath",
  "keeperPythonPath",
];

class SetupError extends Error {}
function reject(code: string): never {
  throw new SetupError(code);
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\r\n\0]/.test(value)
  );
}
function absolutePath(value: unknown): value is string {
  return text(value) && isAbsolute(value) && !value.includes("'");
}
async function smallFile(path: string, privateFile = false): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65_536) reject("invalid-input-file");
  if (privateFile && (info.mode & 0o077) !== 0) reject("input-not-private");
  return readFile(path, "utf8");
}

export interface AuthMaintenanceSetupReport {
  event: "auth_maintenance_setup";
  ok: boolean;
  status: string;
  targetRowCount?: number;
  maintenanceEnabled?: false;
}

/** Generates private operator configuration only; never starts Keeper or reads CLI credentials. */
export async function setupAuthMaintenance(options: {
  input: string;
  output: string;
}): Promise<AuthMaintenanceSetupReport> {
  const result: AuthMaintenanceSetupReport = {
    event: "auth_maintenance_setup",
    ok: false,
    status: "invalid-input",
  };
  try {
    if (!absolutePath(options.input) || !absolutePath(options.output))
      reject("absolute-paths-required");
    const input: unknown = JSON.parse(await smallFile(options.input, true));
    if (typeof input !== "object" || input === null || Array.isArray(input))
      reject("invalid-input");
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).length !== inputKeys.length ||
      !Object.keys(value).every((key) => inputKeys.includes(key))
    )
      reject("invalid-input-fields");
    if (
      !absolutePath(value.gatewayEnvPath) ||
      !absolutePath(value.keeperRepositoryPath) ||
      !absolutePath(value.keeperPythonPath)
    )
      reject("absolute-paths-required");
    if (!text(value.botChatName) || !text(value.authorizationUrl))
      reject("invalid-input");
    const rows = value.targetRows;
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      !rows.every((row) => text(row) && capabilityLabels.has(row)) ||
      new Set(rows).size !== rows.length
    )
      reject("invalid-capability-allowlist");
    const gateway = parseEnv(await smallFile(value.gatewayEnvPath));
    const botId = gateway.WECOM_BOT_ID;
    if (!text(botId) || botId.includes("'") || botId.startsWith("<"))
      reject("gateway-identity-missing");
    let url: URL;
    try {
      url = new URL(value.authorizationUrl);
    } catch {
      reject("invalid-authorization-url");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "work.weixin.qq.com" ||
      (url.port !== "" && url.port !== "443") ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/ai/aiHelper/authorizationList" ||
      !/^https:\/\/work\.weixin\.qq\.com(?::443)?\/ai\/aiHelper\/authorizationList\?/.test(
        value.authorizationUrl,
      ) ||
      url.searchParams.getAll("aibotid").length !== 1 ||
      url.searchParams.getAll("str_aibotid").length !== 1
    )
      reject("invalid-authorization-url");
    const numericId = url.searchParams.get("aibotid")!;
    if (!/^\d+$/.test(numericId)) reject("invalid-authorization-url");
    if (url.searchParams.get("str_aibotid") !== botId)
      reject("identity-mismatch");
    const keeper = await realpath(value.keeperRepositoryPath);
    if (
      !(await stat(keeper)).isDirectory() ||
      !(await stat(join(keeper, "renew.py"))).isFile()
    )
      reject("invalid-keeper-path");
    if (!(await stat(value.keeperPythonPath)).isFile())
      reject("invalid-python-path");
    await access(value.keeperPythonPath, constants.X_OK);

    const requestedOutput = resolve(options.output);
    try {
      await lstat(requestedOutput);
      reject("output-already-exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Resolve only the existing parent; never follow an existing output symlink.
    const output = join(
      await realpath(dirname(requestedOutput)),
      basename(requestedOutput),
    );
    const fromKeeper = relative(keeper, output);
    if (
      fromKeeper === "" ||
      (fromKeeper !== ".." &&
        !fromKeeper.startsWith(`..${sep}`) &&
        !isAbsolute(fromKeeper))
    )
      reject("output-inside-keeper-repository");
    if (!absolutePath(output) || !absolutePath(keeper))
      reject("unsupported-path-characters");
    const state = join(output, "state");
    const keeperConfig = {
      aibotid: numericId,
      str_aibotid: botId,
      bot_chat_name: value.botChatName,
      target_rows: rows,
      bridge_send_link: false,
      bridge_monitor: false,
      venv_python: value.keeperPythonPath,
      state_file: join(state, "keeper.json"),
      log_file: join(state, "keeper.log"),
    };
    const maintenance = [
      "# Private maintenance configuration. No Bot secret; disabled until explicitly enabled.",
      `WECOM_BOT_ID='${botId}'`,
      `WECOM_AUTH_KEEPER_DIR='${keeper}'`,
      `WECOM_AUTH_KEEPER_CONFIG='${join(output, "keeper.json")}'`,
      `WECOM_AUTH_KEEPER_PYTHON='${value.keeperPythonPath}'`,
      "WECOM_AUTH_MAINTENANCE_ENABLED=false",
      "WECOM_AUTH_MAINTENANCE_PRE_RENEW=false",
      "WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY=false",
      `WECOM_AUTH_MAINTENANCE_STATE_DIR='${state}'`,
      "WECOM_AUTH_MAINTENANCE_INTERVAL_MS=3600000",
      "WECOM_AUTH_KEEPER_WITHIN_HOURS=24",
      "",
    ].join("\n");
    // Exclusive directory creation is also the race-safe overwrite guard.
    await mkdir(output, { mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await writeFile(
      join(output, "keeper.json"),
      `${JSON.stringify(keeperConfig, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(join(output, "maintenance.env"), maintenance, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      ...result,
      ok: true,
      status: "configuration-created-disabled",
      targetRowCount: rows.length,
      maintenanceEnabled: false,
    };
  } catch (error) {
    return {
      ...result,
      status:
        error instanceof SetupError
          ? error.message
          : "configuration-not-created-or-incomplete",
    };
  }
}

export async function authMaintenanceSetupMain(
  args: string[],
): Promise<number> {
  let result: AuthMaintenanceSetupReport;
  try {
    const { values } = parseArgs({
      args,
      options: { input: { type: "string" }, output: { type: "string" } },
      allowPositionals: false,
    });
    if (!values.input || !values.output) reject("input-and-output-required");
    result = await setupAuthMaintenance({
      input: values.input,
      output: values.output,
    });
  } catch {
    result = {
      event: "auth_maintenance_setup",
      ok: false,
      status: "invalid-arguments",
    };
  }
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await authMaintenanceSetupMain(process.argv.slice(2));
