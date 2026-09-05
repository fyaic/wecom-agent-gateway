import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFirstRun } from "./check-first-run.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-run acceptance safety", () => {
  it.each([".env", "data", "agent-workspace"])(
    "refuses existing %s before launching a command",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "first-run-guard-"));
      roots.push(root);
      await writeFile(join(root, entry), "private-fixture");
      const log = vi.fn();
      await expect(checkFirstRun(root, log)).rejects.toThrow(
        "checkout-not-pristine",
      );
      expect(log).not.toHaveBeenCalled();
    },
  );
  it("refuses dangling .env symlinks without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "first-run-guard-"));
    roots.push(root);
    await symlink(join(root, "missing"), join(root, ".env"));
    await expect(checkFirstRun(root)).rejects.toThrow("checkout-not-pristine");
  });
});
