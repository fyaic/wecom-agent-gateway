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
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
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
    expect(unit).not.toContain("WECOM_BOT_SECRET=");
  });
});

function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}
