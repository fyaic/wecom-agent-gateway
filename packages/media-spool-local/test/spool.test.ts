import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMediaSpool } from "../src/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalMediaSpool", () => {
  it("copies an allowed source into a protected integrity-checked artifact", async () => {
    const root = temporary("wecom-spool-");
    const sourceRoot = temporary("wecom-spool-source-");
    const source = join(sourceRoot, "report.txt");
    writeFileSync(source, "original", { mode: 0o600 });
    const spool = new LocalMediaSpool({ root, sourceRoots: [sourceRoot] });
    await spool.start();

    const artifact = await spool.stage({
      type: "file",
      path: source,
      name: "../safe-report.txt",
      mimeType: "text/plain",
    });
    writeFileSync(source, "changed", { mode: 0o600 });
    const materialized = await spool.materialize(artifact);

    expect(materialized.path).not.toBe(source);
    expect(readFileSync(materialized.path, "utf8")).toBe("original");
    expect(artifact.name).toBe("safe-report.txt");
    expect(artifact.sizeBytes).toBe(8);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(artifact)).not.toContain(sourceRoot);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(materialized.path).mode & 0o777).toBe(0o600);

    await spool.release(artifact.artifactId);
    expect(existsSync(materialized.path)).toBe(false);
  });

  it("rejects sources outside the allowlist and detects artifact tampering", async () => {
    const root = temporary("wecom-spool-");
    const sourceRoot = temporary("wecom-spool-source-");
    const outsideRoot = temporary("wecom-spool-outside-");
    const outside = join(outsideRoot, "outside.txt");
    writeFileSync(outside, "outside", { mode: 0o600 });
    const allowed = join(sourceRoot, "allowed.txt");
    writeFileSync(allowed, "allowed", { mode: 0o600 });
    const spool = new LocalMediaSpool({ root, sourceRoots: [sourceRoot] });
    await spool.start();
    const overlapping = new LocalMediaSpool({
      root: join(sourceRoot, "nested-spool"),
      sourceRoots: [sourceRoot],
    });
    await expect(overlapping.start()).rejects.toThrow("must not overlap");

    await expect(spool.stage({ type: "file", path: outside })).rejects.toThrow(
      "outside allowed source roots",
    );
    const artifact = await spool.stage({ type: "file", path: allowed });
    const materialized = await spool.materialize(artifact);
    writeFileSync(materialized.path, "tampered", { mode: 0o600 });
    await expect(spool.materialize(artifact)).rejects.toThrow(
      /size mismatch|integrity mismatch/,
    );
  });

  it("enforces total quota and reconciles only project-owned orphan artifacts", async () => {
    const root = temporary("wecom-spool-");
    const sourceRoot = temporary("wecom-spool-source-");
    const first = join(sourceRoot, "first.bin");
    const second = join(sourceRoot, "second.bin");
    writeFileSync(first, "1234", { mode: 0o600 });
    writeFileSync(second, "56", { mode: 0o600 });
    const spool = new LocalMediaSpool({
      root,
      sourceRoots: [sourceRoot],
      maxTotalBytes: 5,
    });
    await spool.start();
    const retained = await spool.stage({ type: "file", path: first });
    await expect(spool.stage({ type: "file", path: second })).rejects.toThrow(
      "total limit",
    );

    const orphan = "00000000-0000-4000-8000-000000000000";
    mkdirSync(join(root, orphan), { mode: 0o700 });
    writeFileSync(join(root, orphan, "data"), "x", { mode: 0o600 });
    mkdirSync(join(root, ".staging-abandoned"), { mode: 0o700 });
    writeFileSync(join(root, "unmanaged.txt"), "keep", { mode: 0o600 });
    await spool.reconcile(new Set([retained.artifactId]));

    expect(existsSync(join(root, retained.artifactId, "data"))).toBe(true);
    expect(existsSync(join(root, orphan))).toBe(false);
    expect(existsSync(join(root, ".staging-abandoned"))).toBe(false);
    expect(existsSync(join(root, "unmanaged.txt"))).toBe(true);
  });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
