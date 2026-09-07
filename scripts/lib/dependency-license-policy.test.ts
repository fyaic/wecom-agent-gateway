import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  isReviewedDependencyLicense,
  isReviewedNonSpdxDependency,
} from "./dependency-license-policy.js";

const name = "@anthropic-ai/claude-agent-sdk";
const sdkRequire = createRequire(
  new URL("../../packages/adapter-claude-code/package.json", import.meta.url),
);
const path = dirname(sdkRequire.resolve(name));
const entry = { name, versions: ["0.3.260"], paths: [path] };

describe("reviewed non-SPDX dependency policy", () => {
  it("routes the actual reviewed SDK through the exact non-SPDX review", () => {
    expect(isReviewedDependencyLicense("Unknown", entry)).toBe(true);
    expect(
      isReviewedDependencyLicense("Unknown", entry, () => {
        throw new Error("missing evidence");
      }),
    ).toBe(false);
  });

  it.each([
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "@anthropic-ai/claude-agent-sdk-darwin-x64",
    "@anthropic-ai/claude-agent-sdk-linux-arm64",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "@anthropic-ai/claude-agent-sdk-win32-arm64",
    "@anthropic-ai/claude-agent-sdk-win32-x64",
  ])(
    "never lets a generic SPDX category bypass review for %s",
    (claudeName) => {
      for (const license of ["MIT", "Apache-2.0", "BSD-3-Clause"]) {
        for (const version of ["0.3.260", "0.3.261"]) {
          expect(
            isReviewedDependencyLicense(license, {
              ...entry,
              name: claudeName,
              versions: [version],
            }),
          ).toBe(false);
        }
      }
      expect(
        isReviewedDependencyLicense("Unknown", {
          ...entry,
          name: claudeName,
          versions: ["0.3.261"],
        }),
      ).toBe(false);
    },
  );

  it("retains the existing SPDX categories for ordinary dependencies", () => {
    const ordinary = { name: "ordinary-dependency", versions: ["1.0.0"] };
    for (const license of [
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "MIT",
      "MPL-2.0",
      "Unlicense",
    ]) {
      expect(isReviewedDependencyLicense(license, ordinary)).toBe(true);
    }
    expect(isReviewedDependencyLicense("Unknown", ordinary)).toBe(false);
    expect(isReviewedDependencyLicense("unreviewed-license", ordinary)).toBe(
      false,
    );
  });

  it("accepts the installed exact SDK only with its reviewed notice", () => {
    expect(isReviewedNonSpdxDependency(entry)).toBe(true);
  });

  it.each([["0.3.258"], ["0.3.261"], ["0.3.260", "0.3.261"], []])(
    "rejects unreviewed or mixed versions %j",
    (...versions) => {
      expect(isReviewedNonSpdxDependency({ ...entry, versions })).toBe(false);
    },
  );

  it("rejects unknown package names and missing installation evidence", () => {
    expect(
      isReviewedNonSpdxDependency({ ...entry, name: `${name}-other` }),
    ).toBe(false);
    expect(isReviewedNonSpdxDependency({ ...entry, paths: [] })).toBe(false);
    expect(isReviewedNonSpdxDependency({ ...entry, paths: undefined })).toBe(
      false,
    );
  });

  it("rejects changed notices without propagating their contents", () => {
    expect(
      isReviewedNonSpdxDependency(entry, (file) =>
        file.endsWith("LICENSE.md")
          ? "unreviewed private content"
          : readFileSync(file, "utf8"),
      ),
    ).toBe(false);
  });

  it("rejects a missing notice and a manifest inconsistent with the inventory", () => {
    expect(
      isReviewedNonSpdxDependency(entry, () => {
        throw new Error("private path");
      }),
    ).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(path, "package.json"), "utf8"),
    );
    expect(
      isReviewedNonSpdxDependency(entry, (file) =>
        file.endsWith("package.json")
          ? JSON.stringify({ ...manifest, license: "MIT" })
          : readFileSync(file, "utf8"),
      ),
    ).toBe(false);
  });
});
