import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBotOwnerLock,
  BotOwnerConflictError,
} from "../src/bot-owner-lock.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Bot owner lock", () => {
  it("fails fast when another process owns the same Bot account", async () => {
    const root = temporaryRoot();
    const first = await acquireBotOwnerLock({
      accountId: "bot-account-a",
      root,
    });

    await expect(
      acquireBotOwnerLock({ accountId: "bot-account-a", root }),
    ).rejects.toBeInstanceOf(BotOwnerConflictError);
    expect(first.path).not.toContain("bot-account-a");

    await first.release();
    const replacement = await acquireBotOwnerLock({
      accountId: "bot-account-a",
      root,
    });
    await replacement.release();
  });

  it("allows different Bot accounts to have independent owners", async () => {
    const root = temporaryRoot();
    const first = await acquireBotOwnerLock({
      accountId: "bot-account-a",
      root,
    });
    const second = await acquireBotOwnerLock({
      accountId: "bot-account-b",
      root,
    });

    expect(first.path).not.toBe(second.path);
    await Promise.all([first.release(), second.release()]);
  });

  it("reclaims a same-host lock whose process no longer exists", async () => {
    const root = temporaryRoot();
    const stale = await acquireBotOwnerLock({
      accountId: "bot-account-a",
      root,
      pid: 2_147_483_647,
    });

    const replacement = await acquireBotOwnerLock({
      accountId: "bot-account-a",
      root,
    });
    expect(replacement.path).toBe(stale.path);

    await stale.release();
    await expect(
      acquireBotOwnerLock({ accountId: "bot-account-a", root }),
    ).rejects.toBeInstanceOf(BotOwnerConflictError);
    await replacement.release();
  });
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "wecom-owner-lock-test-"));
  directories.push(directory);
  return directory;
}
