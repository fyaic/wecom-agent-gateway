import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

export function firstRunEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  // Preserve tool locations unchanged. These are not replacement home directories.
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "PNPM_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "LANG",
    "LC_ALL",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

// Developer acceptance only: requires a disposable checkout, never the running Bot directory.
export async function checkFirstRun(
  root: string,
  log: (value: unknown) => void = console.log,
) {
  for (const entry of [".env", "agent-workspace", "data"]) {
    try {
      await lstat(resolve(root, entry));
      throw new Error("checkout-not-pristine");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("checkout-not-pristine");
    }
  }
  // Do not let existing Bot/model settings or NODE_OPTIONS satisfy a first-run check.
  const env = firstRunEnvironment(process.env);
  let checks = 0;
  const run = async (args: string[], expectedCode: number) => {
    log({ event: "first_run_command", command: args[0] });
    try {
      const result = await exec("pnpm", args, {
        cwd: root,
        env,
        timeout: 60_000,
        maxBuffer: 1_048_576,
      });
      if (expectedCode !== 0) throw new Error("unexpected-command-success");
      return result.stdout;
    } catch (error) {
      const result = error as {
        code?: unknown;
        stdout?: string;
        stderr?: string;
      };
      if (result.code !== expectedCode || typeof result.stdout !== "string") {
        log({
          event: "first_run_command_failed",
          command: args[0],
          exitCode: typeof result.code === "number" ? result.code : null,
        });
        throw new Error("command-outcome-mismatch");
      }
      return result.stdout;
    }
  };
  const require = (condition: boolean, code: string) => {
    if (!condition) throw new Error(code);
  };
  const pass = (stage: string) => {
    checks++;
    log({ event: "first_run_stage", stage, passed: true });
  };

  const demo = await run(["demo"], 0);
  require(demo.includes("6/6 checks passed"), "demo-incomplete");
  pass("credential-free-demo");

  await run(["onboard", "--adapter", "echo"], 0);
  const original = await readFile(resolve(root, ".env"), "utf8");
  const config = parseEnv(original);
  require(config.GATEWAY_ADAPTER === "external" &&
    config.WECOM_BOT_ID === "" &&
    config.WECOM_BOT_SECRET === "" &&
    config.WECOM_ALLOWED_DIRECT_SENDERS === "", "starter-config-invalid");
  require(config.GATEWAY_REPLY_ACTIONS_JSON === "[]" &&
    config.GATEWAY_RUN_CONTROL_ENABLED === "false", "unexpected-default-cards");
  require(((await lstat(resolve(root, ".env"))).mode & 0o777) ===
    0o600, "starter-permissions-invalid");
  require((
    await lstat(resolve(root, "agent-workspace"))
  ).isDirectory(), "workspace-missing");
  pass("private-starter-without-credentials");

  const doctor = await run(["doctor"], 1);
  const rows = doctor
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { name?: string; status?: string });
  const errors = rows
    .filter((row) => row.status === "error")
    .map((row) => row.name)
    .sort();
  require(JSON.stringify(errors) ===
    JSON.stringify([
      "local-control-targets",
      "wecom-allowlist",
      "wecom-bot-credentials",
    ]), "doctor-missing-credentials-mismatch");
  require(rows.some(
    (row) => row.name === "external-adapter-config" && row.status === "ok",
  ), "starter-adapter-not-loadable");
  pass("missing-bot-and-acl-fail-closed");

  await run(["onboard", "--adapter", "pi"], 1);
  require((await readFile(resolve(root, ".env"), "utf8")) ===
    original, "starter-overwrote-config");
  pass("repeat-setup-keeps-config");

  const status = await run(["gateway:status"], 1);
  require(status.includes('"status": "disabled"'), "status-not-disabled");
  pass("disabled-observability-is-explicit");

  log({
    event: "first_run_completed",
    passed: true,
    checks,
    evidence: "local-cli-no-bot-no-model",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkFirstRun(resolve(import.meta.dirname, ".."), (value) =>
      console.log(JSON.stringify(value)),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "first_run_completed",
        passed: false,
        error: "fresh-checkout-or-command-check-failed",
        hint: "Use a disposable checkout without .env, data or agent-workspace; inspect the last completed stage.",
      }),
    );
    process.exitCode = 1;
  }
}
