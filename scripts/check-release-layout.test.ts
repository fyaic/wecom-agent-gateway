import { describe, expect, it, vi } from "vitest";
import { checkReleaseLayout } from "./check-release-layout.js";

describe("isolated release-layout acceptance", () => {
  it("checks real starter configuration and cold SQLite restore without services", async () => {
    const log = vi.fn();
    await checkReleaseLayout(log);
    expect(log.mock.calls.map(([event]) => event.stage)).toEqual([
      "shared-private-config-survives-two-release-directories",
      "dangling-config-is-not-overwritten",
      "closed-sqlite-snapshot-and-same-version-reopen",
      "restore-preserves-snapshot-but-loses-newer-events",
      "newer-sqlite-schema-fails-closed",
    ]);
    for (const [event] of log.mock.calls) {
      expect(event).toMatchObject({
        passed: true,
        evidence: "local-fixture-no-bot-no-model",
      });
      expect(Object.keys(event).sort()).toEqual([
        "evidence",
        "passed",
        "stage",
      ]);
    }
  });

  it("can repeat without overwriting caller-owned configuration or keeping fixture state", async () => {
    await checkReleaseLayout(() => undefined);
    await checkReleaseLayout(() => undefined);
  });
});
