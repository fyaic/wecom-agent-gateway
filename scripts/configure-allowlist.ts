import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Session {
  chat_id?: unknown;
  chat_name?: unknown;
  chat_type?: unknown;
}

interface SessionResponse {
  sessions?: unknown;
}

export function parseAuthorizedHumanId(context: string): string {
  const match = context.match(/授权真人用户身份：[\s\S]*?ID：\s*([^\s<]+)/);
  if (!match?.[1]) {
    throw new Error("无法解析 wecom-cli 当前授权真人身份");
  }
  return match[1];
}

export function resolveGroupConversationId(
  response: SessionResponse,
  groupName: string,
): string | undefined {
  const sessions = Array.isArray(response.sessions)
    ? (response.sessions as Session[])
    : [];
  const matches = sessions.filter(
    (session) =>
      session.chat_name === groupName &&
      session.chat_type !== "single" &&
      typeof session.chat_id === "string" &&
      session.chat_id.length > 0,
  );
  if (matches.length > 1) {
    throw new Error(`群聊名称“${groupName}”不唯一，拒绝生成白名单`);
  }
  return matches[0]?.chat_id as string | undefined;
}

export function setEnvValue(
  source: string,
  key: string,
  value: string,
): string {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
  return `${source}${separator}${line}\n`;
}

export function getEnvValue(source: string, key: string): string {
  const raw = source.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw) as string;
  }
  return raw;
}

function run(): void {
  const directName = option("--direct");
  const groupName = option("--group");
  const envPath = option("--env") ?? ".env";
  if (!directName || !groupName) {
    throw new Error("必须通过 --direct 和 --group 提供唯一的私聊与群聊名称");
  }

  const sessions = jsonCommand(["message", "aibot", "sessions", "list"]);
  const groupConversationId = resolveGroupConversationId(sessions, groupName);

  let env = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
    : readFileSync(".env.example", "utf8");
  const directConfigured = Boolean(
    getEnvValue(env, "WECOM_ALLOWED_DIRECT_SENDERS"),
  );
  env = setEnvValue(env, "WECOM_ALLOWED_SENDERS", "");
  env = setEnvValue(env, "WECOM_ALLOWED_CONVERSATIONS", "");
  env = setEnvValue(
    env,
    "WECOM_ALLOWED_GROUP_CONVERSATIONS",
    groupConversationId ?? "",
  );
  writeFileSync(envPath, env, { encoding: "utf8", mode: 0o600 });
  chmodSync(envPath, 0o600);

  console.log(
    JSON.stringify({
      direct_chat: directConfigured ? "configured" : "requires_enrollment",
      direct_name: directName,
      group_chat: groupConversationId ? "configured" : "not_visible",
      group_name: groupName,
      env_path: envPath,
      ready: directConfigured && Boolean(groupConversationId),
    }),
  );
}

function jsonCommand(args: string[]): Record<string, unknown> {
  const output = execFileSync("wecom-cli", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as Record<string, unknown>;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
}
