import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lockfile = readFileSync(
  new URL("../../pnpm-lock.yaml", import.meta.url),
  "utf8",
);
const packageSection = lockfile
  .split("\npackages:\n")[1]
  ?.split("\nsnapshots:\n")[0];

// Dependabot remediation baseline, 2026-10-10. This prevents reintroducing the
// known vulnerable versions; it does not replace an up-to-date dependency audit.
const patchedFloors = [
  ["@modelcontextprotocol/sdk", "1.31.0"],
  ["axios", "1.20.0"],
  ["fast-uri", "3.1.8"],
  ["hono", "4.13.7"],
  ["ip-address", "10.7.1"],
  ["proxy-addr", "2.0.8"],
  ["source-map-js", "1.2.2"],
] as const;

function atLeast(version: string, floor: string): boolean {
  const actual = version.split(".").map(Number);
  const minimum = floor.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) {
      return actual[index]! > minimum[index]!;
    }
  }
  return true;
}

describe("known dependency security remediation", () => {
  it.each(patchedFloors)(
    "keeps every locked %s version at least %s",
    (name, floor) => {
      expect(packageSection).toBeDefined();
      const entries = [
        ...packageSection!.matchAll(/^  '?([^\s']+)@([\d.]+)'?:$/gm),
      ];
      const versions = entries
        .filter((entry) => entry[1] === name)
        .map((entry) => entry[2]!);
      expect(
        versions.length,
        `${name} missing from dependency inventory`,
      ).toBeGreaterThan(0);
      for (const version of versions) {
        expect(
          atLeast(version, floor),
          `${name}@${version} is below ${floor}`,
        ).toBe(true);
      }
    },
  );

  it("explicitly supplies the patched MCP peer without making Claude mandatory", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../packages/adapter-claude-code/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      manifest.optionalDependencies["@anthropic-ai/claude-agent-sdk"],
    ).toBeDefined();
    const mcp = manifest.optionalDependencies["@modelcontextprotocol/sdk"];
    expect(mcp).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(mcp, "1.31.0")).toBe(true);
    expect(
      manifest.dependencies["@anthropic-ai/claude-agent-sdk"],
    ).toBeUndefined();
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
  });
});
