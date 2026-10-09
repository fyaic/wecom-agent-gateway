import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const directoryKeys = [
  "WECOM_CLI_CONFIG_DIR",
  "WECOM_CLI_TMP_DIR",
  "WECOM_CLI_LOG_DIR",
] as const;
const maxOutputBytes = 131_072;
const timeoutMs = 15_000;
type ProbeCode =
  | "verified"
  | "invalid-configuration"
  | "profile-unavailable"
  | "cli-failed"
  | "cli-timeout"
  | "cli-output-too-large"
  | "authorization-required"
  | "authorization-status-invalid"
  | "identity-response-invalid"
  | "identity-mismatch"
  | "capability-response-invalid";
export interface CliCapabilityReport {
  event: "cli_capability_probe";
  ok: boolean;
  code: ProbeCode;
  identity: "matched" | "not-verified";
  capability: "message-sessions";
  businessVerified: boolean;
  count?: number;
}
export interface CliProbeInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface CliProbeProcessResult {
  exitCode: number | null;
  stdout: string;
  failure?: "timeout" | "output-too-large" | "process-failed";
}
export type CliProbeRunner = (
  invocation: CliProbeInvocation,
) => Promise<CliProbeProcessResult>;

/** Fresh child environment: never inherit CLI token/header/endpoint overrides or runtime injections. */
export function cliProbeEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  for (const key of directoryKeys) env[key] = source[key];
  return env;
}

/** Internal captured result only; callers must never print stdout/stderr/errors. */
export const runCliProbeProcess: CliProbeRunner = (invocation) =>
  new Promise((done) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env: invocation.env,
        encoding: "utf8",
        timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (!error) return done({ exitCode: 0, stdout });
        done({
          exitCode: typeof error.code === "number" ? error.code : null,
          stdout,
          failure:
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "output-too-large"
              : error.killed
                ? "timeout"
                : "process-failed",
        });
      },
    );
  });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject duplicate top-level keys; JSON.parse alone would silently choose the last identity. */
function responseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed)) return;
    const keys = new Set<string>();
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"') {
        const start = i++;
        for (; i < raw.length; i++) {
          if (raw[i] === "\\") i++;
          else if (raw[i] === '"') break;
        }
        let next = i + 1;
        while (/\s/.test(raw[next] ?? "x")) next++;
        if (depth === 1 && raw[next] === ":") {
          const key = JSON.parse(raw.slice(start, i + 1)) as string;
          if (keys.has(key)) return;
          keys.add(key);
        }
      }
    }
    return parsed;
  } catch {
    return;
  }
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.@-]{1,256}$/.test(value);
}

/** Only the observed official 1.1.0 identity text contract is accepted. Never execute its prose. */
export function parseCliBotIdentity(raw: string): string | undefined {
  const payload = responseObject(raw);
  if (
    !payload ||
    !Object.keys(payload).every((key) =>
      ["extra_identity_context", "security_notice"].includes(key),
    ) ||
    typeof payload.extra_identity_context !== "string"
  )
    return;
  if (
    payload.security_notice !== undefined &&
    (typeof payload.security_notice !== "string" ||
      !payload.security_notice.trim())
  )
    return;
  const context = payload.extra_identity_context;
  for (const marker of [
    "<extra_identity_context>",
    "</extra_identity_context>",
    "机器人身份：",
    "授权真人用户身份：",
  ])
    if (context.split(marker).length !== 2) return;
  const lines = context
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (
    lines.length < 8 ||
    lines[0] !== "<extra_identity_context>" ||
    lines.at(-1) !== "</extra_identity_context>" ||
    lines[1] !== "机器人身份：" ||
    lines[4] !== "授权真人用户身份："
  )
    return;
  if (!/^名字：\s*\S/.test(lines[2]!) || !/^名字：\s*\S/.test(lines[5]!))
    return;
  if (
    !lines[3]?.startsWith("ID：") ||
    !lines[6]?.startsWith("ID：") ||
    context.split("ID：").length !== 3
  )
    return;
  const bot = lines[3].slice(3).trim();
  const human = lines[6].slice(3).trim();
  return identifier(bot) && identifier(human) ? bot : undefined;
}

function sessionCount(raw: string): number | undefined {
  const payload = responseObject(raw);
  if (
    !payload ||
    !Object.keys(payload).every((key) =>
      [
        "sessions",
        "sessions_count",
        "security_notice",
        "extra_identity_context",
      ].includes(key),
    ) ||
    !Array.isArray(payload.sessions) ||
    payload.sessions.length > 20
  )
    return;
  if (
    payload.security_notice !== undefined &&
    typeof payload.security_notice !== "string"
  )
    return;
  if (
    payload.sessions_count !== undefined &&
    payload.sessions_count !== payload.sessions.length
  )
    return;
  if (
    !payload.sessions.every(
      (session) =>
        record(session) &&
        typeof session.chat_id === "string" &&
        session.chat_id.trim() !== "" &&
        ["single", "group"].includes(session.chat_type as string),
    )
  )
    return;
  return payload.sessions.length;
}
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** Read-only business probe, opt-in through an explicit dedicated profile. No init or fallback. */
export async function probeCliMessageSessions(
  options: { env?: NodeJS.ProcessEnv; run?: CliProbeRunner } = {},
): Promise<CliCapabilityReport> {
  const env = options.env ?? process.env;
  const result: CliCapabilityReport = {
    event: "cli_capability_probe",
    ok: false,
    code: "invalid-configuration",
    identity: "not-verified",
    capability: "message-sessions",
    businessVerified: false,
  };
  const fail = (code: ProbeCode): CliCapabilityReport => ({ ...result, code });
  if (!identifier(env.WECOM_BOT_ID)) return fail("invalid-configuration");
  for (const key of directoryKeys)
    if (
      !env[key] ||
      env[key]!.trim() !== env[key] ||
      !isAbsolute(env[key]!) ||
      /[\r\n\0]/.test(env[key]!)
    )
      return fail("invalid-configuration");
  const childEnv = cliProbeEnvironment(env);
  try {
    const canonical = [];
    for (const key of directoryKeys) {
      const info = await lstat(env[key]!);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0
      )
        return fail("profile-unavailable");
      const path = await realpath(env[key]!);
      canonical.push(path);
      childEnv[key] = path;
    }
    for (let i = 0; i < canonical.length; i++)
      for (let j = i + 1; j < canonical.length; j++)
        if (
          isInside(canonical[i]!, canonical[j]!) ||
          isInside(canonical[j]!, canonical[i]!)
        )
          return fail("profile-unavailable");
    // Do not accept the user's default profile as an explicitly dedicated one.
    const defaultProfile = join(homedir(), ".config", "wecom");
    let defaultCanonical = resolve(defaultProfile);
    try {
      defaultCanonical = await realpath(defaultProfile);
    } catch {
      /* Missing default profile is normal. */
    }
    if (
      canonical.some(
        (path) =>
          isInside(defaultCanonical, path) || isInside(path, defaultCanonical),
      )
    )
      return fail("profile-unavailable");
  } catch {
    return fail("profile-unavailable");
  }
  const run = options.run ?? runCliProbeProcess;
  const invoke = async (args: string[]): Promise<CliProbeProcessResult> => {
    try {
      return await run({
        command: "wecom-cli",
        args,
        env: childEnv,
        timeoutMs,
        maxOutputBytes,
      });
    } catch {
      return { exitCode: null, stdout: "", failure: "process-failed" };
    }
  };
  const failure = (response: CliProbeProcessResult): ProbeCode | undefined => {
    if (response.failure === "timeout") return "cli-timeout";
    if (
      response.failure === "output-too-large" ||
      typeof response.stdout !== "string" ||
      Buffer.byteLength(response.stdout) > maxOutputBytes
    )
      return "cli-output-too-large";
    return response.failure || response.exitCode !== 0
      ? "cli-failed"
      : undefined;
  };
  const auth = await invoke(["auth", "show", "--status"]);
  const authFailure = failure(auth);
  if (authFailure) return fail(authFailure);
  if (auth.stdout.trim() === "unauthorized")
    return fail("authorization-required");
  if (auth.stdout.trim() !== "authorized")
    return fail("authorization-status-invalid");
  const identity = await invoke(["identity", "whoami"]);
  const identityFailure = failure(identity);
  if (identityFailure) return fail(identityFailure);
  const actualBot = parseCliBotIdentity(identity.stdout);
  if (actualBot === undefined) return fail("identity-response-invalid");
  if (actualBot !== env.WECOM_BOT_ID) return fail("identity-mismatch");
  result.identity = "matched";
  const capability = await invoke(["message", "aibot", "sessions", "list"]);
  const capabilityFailure = failure(capability);
  if (capabilityFailure) return fail(capabilityFailure);
  // The business response must independently bind to the same Bot. A matching
  // preceding whoami cannot protect against profile changes between processes.
  const payload = responseObject(capability.stdout);
  const businessIdentity = payload
    ? parseCliBotIdentity(
        JSON.stringify({
          extra_identity_context: payload.extra_identity_context,
          ...(payload.security_notice !== undefined
            ? { security_notice: payload.security_notice }
            : {}),
        }),
      )
    : undefined;
  if (businessIdentity === undefined) {
    result.identity = "not-verified";
    return fail("capability-response-invalid");
  }
  if (businessIdentity !== env.WECOM_BOT_ID) {
    result.identity = "not-verified";
    return fail("identity-mismatch");
  }
  const count = sessionCount(capability.stdout);
  if (count === undefined) return fail("capability-response-invalid");
  return {
    ...result,
    ok: true,
    code: "verified",
    businessVerified: true,
    count,
  };
}
