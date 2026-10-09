import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { authProbeMain } from "./auth-probe.js";

describe("read-only capability probe command", () => {
  it("requires an explicit environment file and never falls back to default profile", async () => {
    const probe = vi.fn();
    expect(await authProbeMain([], { probe, emit: vi.fn() })).toBe(2);
    expect(probe).not.toHaveBeenCalled();
  });
  it("uses the supplied Bot configuration and emits only the probe report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auth-probe-cli-"));
    try {
      const path = join(dir, "private.env");
      await writeFile(path, "WECOM_BOT_ID=fixture-bot\n", { mode: 0o600 });
      const probe = vi.fn<
        typeof import("./lib/cli-capability-probe.js").probeCliMessageSessions
      >(async () => ({
        event: "cli_capability_probe",
        ok: true,
        code: "verified",
        identity: "matched",
        capability: "message-sessions",
        businessVerified: true,
        count: 0,
      }));
      const emit = vi.fn();
      expect(
        await authProbeMain(["--env-file", path], {
          env: { WECOM_BOT_ID: "other" },
          probe,
          emit,
        }),
      ).toBe(0);
      expect(probe).toHaveBeenCalledWith({
        env: { WECOM_BOT_ID: "fixture-bot" },
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain("fixture-bot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not expose filesystem errors or input paths", async () => {
    const emit = vi.fn();
    await authProbeMain(["--env-file", "/private/missing-fixture.env"], {
      emit,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("missing-fixture");
  });
});
