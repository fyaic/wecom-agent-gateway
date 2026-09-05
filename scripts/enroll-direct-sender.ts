import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { acquireBotOwnerLock } from "../apps/gateway/src/bot-owner-lock.js";
import { WeComBotTransport } from "../packages/transport-wecom-bot/src/index.js";
import { getEnvValue, setEnvValue } from "./configure-allowlist.js";

export function isEnrollmentMessage(
  message: InboundMessage,
  token: string,
): boolean {
  return (
    message.conversationType === "direct" &&
    message.parts.some(
      (part) => part.type === "text" && part.text.trim() === token,
    )
  );
}

export async function runEnrollment(): Promise<void> {
  const directName = option("--name") ?? "authorized direct chat";
  const envPath = option("--env") ?? ".env";
  const token =
    option("--token") ?? `WECOM_ENROLL_${randomBytes(8).toString("hex")}`;
  const timeoutMs = Number(option("--timeout-ms") ?? "120000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new Error(
      "Enrollment timeout must be between 1 and 600000 milliseconds",
    );
  }
  const botId = required("WECOM_BOT_ID");
  const secret = required("WECOM_BOT_SECRET");
  // Verify the target exists before opening a Bot connection.
  readFileSync(envPath, "utf8");

  let settle: ((senderId: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const match = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Connection errors may occur before start() returns; always observe rejection.
  void match.catch(() => undefined);
  const transport = new WeComBotTransport({
    accountId: botId,
    botId,
    secret,
    onError: (error) => fail?.(error),
  });
  const owner = await acquireBotOwnerLock({
    accountId: botId,
    root: process.env.GATEWAY_OWNER_LOCK_ROOT || undefined,
  });

  console.log(
    JSON.stringify({
      event: "direct_enrollment_waiting",
      direct_name: directName,
      token,
      timeout_ms: timeoutMs,
    }),
  );
  const timeout = setTimeout(
    () => fail?.(new Error("等待私聊注册口令超时")),
    timeoutMs,
  );
  try {
    await transport.start(async (message) => {
      if (isEnrollmentMessage(message, token)) settle?.(message.senderId);
    });
    const senderId = await match;
    let env = readFileSync(envPath, "utf8");
    const senders = new Set(
      getEnvValue(env, "WECOM_ALLOWED_DIRECT_SENDERS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    senders.add(senderId);
    env = setEnvValue(
      env,
      "WECOM_ALLOWED_DIRECT_SENDERS",
      [...senders].join(","),
    );
    writeFileSync(envPath, env, { encoding: "utf8", mode: 0o600 });
    chmodSync(envPath, 0o600);
    console.log(
      JSON.stringify({
        event: "direct_enrollment_complete",
        direct_name: directName,
        sender_id_disclosed: false,
      }),
    );
  } finally {
    clearTimeout(timeout);
    try {
      await transport.stop();
    } finally {
      await owner.release();
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runEnrollment();
}
