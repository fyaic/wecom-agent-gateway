import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("production deployment artifacts", () => {
  it("keeps secrets out of the image and runs the container as non-root", async () => {
    const [dockerfile, ignore, compose] = await Promise.all([
      read("Dockerfile"),
      read(".dockerignore"),
      read("compose.yaml"),
    ]);
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^data$/m);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("--prod --no-optional");
    expect(dockerfile).toContain("tsx@4.23.1");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('CMD ["pnpm", "healthcheck"]');
    expect(dockerfile).not.toContain("WECOM_BOT_SECRET=");
    expect(dockerfile).toContain(
      "GATEWAY_OWNER_LOCK_ROOT=/var/lib/wecom-agent-gateway/owner-locks",
    );
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain(
      "GATEWAY_OWNER_LOCK_ROOT: /var/lib/wecom-agent-gateway/owner-locks",
    );
    expect(compose).not.toMatch(/^\s+ports:/m);
  });

  it("uses a private systemd service boundary without embedded credentials", async () => {
    const unit = await read("deploy/linux/wecom-agent-gateway.service.example");
    expect(unit).toContain(
      "EnvironmentFile=/etc/wecom-agent-gateway/gateway.env",
    );
    expect(unit).toContain("User=wecom-gateway");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain(
      "ExecStartPre=__NODE_PATH__ --import tsx scripts/doctor.ts",
    );
    expect(unit).toContain(
      "ExecStart=__NODE_PATH__ --import tsx apps/gateway/src/index.ts",
    );
    expect(unit).not.toContain("ExecStart=__PNPM_PATH__ start");
    expect(unit).not.toContain("__PNPM_PATH__");
    expect(unit).not.toContain("SuccessExitStatus=143");
    expect(unit).not.toContain("WECOM_BOT_SECRET=");
    expect(unit).toContain(
      "GATEWAY_OWNER_LOCK_ROOT=/var/lib/wecom-agent-gateway/owner-locks",
    );
  });

  it("keeps the dedicated Linux VM resource-bounded and unshared", async () => {
    const config = await read("deploy/linux/lima-lab.yaml");
    expect(config).toContain("plain: true");
    expect(config).toContain("cpus: 2");
    expect(config).toContain("memory: 2GiB");
    expect(config).toContain("disk: 10GiB");
    expect(config).toContain("mounts: []");
    expect(config).toContain("forwardAgent: false");
    expect(config).toContain("loadDotSSHPubKeys: false");
    expect(config).toContain("portForwards: []");
  });

  it("revalidates tagged source before publishing version-matched notes", async () => {
    const release = await read(".github/workflows/release.yml");
    expect(release).toContain("fetch-depth: 0");
    expect(release).toContain(
      'git merge-base --is-ancestor "${GITHUB_SHA}" origin/main',
    );
    expect(release).toContain("pnpm run ci");
    expect(release).toContain("pnpm run public:history-check");
    expect(release).toContain("docs/releases/${GITHUB_REF_NAME}.md");
    expect(release).not.toContain("--notes-file docs/releases/v0.1.0.md");
  });

  it("prevents the real media smoke from competing with a running Bot owner", async () => {
    const smoke = await read("scripts/smoke-media-outbox.ts");
    expect(smoke).toContain("acquireBotOwnerLock");
    expect(smoke).toContain("await botOwner.release()");
  });

  it("ships a fail-closed Linux/systemd 24-hour soak gate", async () => {
    const soak = await read("scripts/linux-soak.ts");
    expect(soak).toContain("CERTIFYING_MINIMUM_MS = 24 * 60 * 60 * 1_000");
    expect(soak).toContain("systemctl");
    expect(soak).toContain("journalctl");
    expect(soak).toContain("externallyAttested: false");
    expect(soak).not.toContain("--output-fields=MESSAGE");
  });
});

function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}
