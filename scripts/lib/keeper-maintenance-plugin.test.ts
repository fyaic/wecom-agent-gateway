import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeeperMaintenancePlugin,
  keeperObservation,
} from "./keeper-maintenance-plugin.js";
import type { KeeperReport, inspectAuthKeeper } from "./auth-keeper.js";

const report: KeeperReport = {
  schemaVersion: 1,
  event: "auth_keeper",
  mode: "inspect",
  ok: true,
  status: "healthy",
  scope: "optional-cli-capabilities",
  targetRowCount: 1,
  identity: "page-verified",
  businessApi: "not-verified",
  cliCredentialIdentity: "not-verified",
  transport: "not-checked",
  observation: {
    observedAtMs: 1,
    earliestExpiryMs: 2,
    expiredCount: 0,
    pendingRecovery: false,
  },
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "keeper-plugin-test-"));
  dirs.push(dir);
  const config = join(dir, "keeper.json");
  await writeFile(config, "{}", { mode: 0o600 });
  return {
    config,
    env: {
      WECOM_BOT_ID: "test-only-bot",
      WECOM_AUTH_KEEPER_CONFIG: config,
      WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY: "false",
    },
  };
}
describe("keeper maintenance plugin", () => {
  it("never promotes page evidence into business verification", () => {
    expect(keeperObservation(report)).toMatchObject({
      status: "healthy",
      businessVerified: false,
    });
    expect(
      keeperObservation({ ...report, identity: "configuration-matched" }),
    ).toMatchObject({ status: "unavailable", identityVerified: false });
    expect(
      keeperObservation({
        ...report,
        ok: false,
        observation: { ...report.observation!, expiredCount: 1 },
      }),
    ).toMatchObject({ status: "expired", businessVerified: false });
  });
  it("pins exact config snapshot and restricts pre-renew navigation", async () => {
    const { env } = await fixture();
    const inspect = vi.fn<typeof inspectAuthKeeper>(async () => report);
    const plugin = await createKeeperMaintenancePlugin({ env, inspect });
    await plugin.inspect();
    await plugin.renew({ preRenew: true, withinHours: 12 });
    expect(inspect.mock.calls[0]?.[0]).toMatchObject({
      mode: "inspect",
      existingWindowOnly: false,
      expectedConfigDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedConfigPath: expect.any(String),
    });
    expect(inspect.mock.calls[1]?.[0]).toMatchObject({
      mode: "pre-renew",
      existingWindowOnly: true,
      withinHours: 12,
    });
  });
  it("refuses mid-worker config changes and isolates next worker state", async () => {
    const { env, config } = await fixture();
    const inspect = vi.fn<typeof inspectAuthKeeper>(async () => report);
    const old = await createKeeperMaintenancePlugin({ env, inspect });
    await writeFile(config, '{"changed":true}');
    expect(await old.inspect()).toMatchObject({ status: "unavailable" });
    expect(inspect).not.toHaveBeenCalled();
    const next = await createKeeperMaintenancePlugin({ env, inspect });
    expect(next.binding).not.toBe(old.binding);
  });
  it("does not expose raw keeper errors", async () => {
    const { env } = await fixture();
    const plugin = await createKeeperMaintenancePlugin({
      env,
      inspect: async () => {
        throw new Error("private-url");
      },
    });
    expect(JSON.stringify(await plugin.inspect())).not.toContain("private-url");
  });
});
