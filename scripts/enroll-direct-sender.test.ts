import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBotOwnerLock } from "../apps/gateway/src/bot-owner-lock.js";
import { WeComBotTransport } from "../packages/transport-wecom-bot/src/index.js";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { isEnrollmentMessage, runEnrollment } from "./enroll-direct-sender.js";

const directories: string[] = [];
const originalArgv = process.argv;
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function enrollmentEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "wecom-enrollment-test-"));
  directories.push(directory);
  const envPath = join(directory, ".env");
  await writeFile(envPath, 'WECOM_ALLOWED_DIRECT_SENDERS="existing"\n');
  vi.stubEnv("WECOM_BOT_ID", "fixture-bot");
  vi.stubEnv("WECOM_BOT_SECRET", "fixture-secret");
  vi.stubEnv("GATEWAY_OWNER_LOCK_ROOT", join(directory, "locks"));
  process.argv = [
    "node",
    "enroll",
    "--env",
    envPath,
    "--token",
    "TOKEN",
    "--timeout-ms",
    "1000",
  ];
  const start = vi
    .spyOn(WeComBotTransport.prototype, "start")
    .mockImplementation(async (onMessage) => {
      await onMessage(message("direct", "TOKEN"));
    });
  vi.spyOn(WeComBotTransport.prototype, "stop").mockResolvedValue();
  return { directory, envPath, start };
}

const message = (conversationType: "direct" | "group", text: string) =>
  ({
    id: "message",
    accountId: "bot",
    conversationId: "conversation",
    conversationType,
    senderId: "sender",
    receivedAt: "2026-08-20T00:00:00.000Z",
    parts: [{ type: "text", text }],
  }) satisfies InboundMessage;

describe("direct sender enrollment", () => {
  it("accepts only an exact token from a direct chat", () => {
    expect(isEnrollmentMessage(message("direct", "TOKEN"), "TOKEN")).toBe(true);
    expect(isEnrollmentMessage(message("group", "TOKEN"), "TOKEN")).toBe(false);
    expect(isEnrollmentMessage(message("direct", "OTHER"), "TOKEN")).toBe(
      false,
    );
  });

  it("refuses to open a second Bot connection during enrollment", async () => {
    const { directory, start } = await enrollmentEnvironment();
    const owner = await acquireBotOwnerLock({
      accountId: "fixture-bot",
      root: join(directory, "locks"),
    });
    try {
      await expect(runEnrollment()).rejects.toThrow("already owns");
      expect(start).not.toHaveBeenCalled();
    } finally {
      await owner.release();
    }
  });

  it("appends an enrolled sender without losing or duplicating existing members", async () => {
    const { envPath } = await enrollmentEnvironment();
    await runEnrollment();
    await runEnrollment();
    expect(await readFile(envPath, "utf8")).toBe(
      'WECOM_ALLOWED_DIRECT_SENDERS="existing,sender"\n',
    );
  });

  it("releases Bot ownership after a startup failure so a retry can succeed", async () => {
    const { start } = await enrollmentEnvironment();
    start.mockRejectedValueOnce(new Error("fixture-start-failed"));
    await expect(runEnrollment()).rejects.toThrow("fixture-start-failed");
    await expect(runEnrollment()).resolves.toBeUndefined();
  });
});
