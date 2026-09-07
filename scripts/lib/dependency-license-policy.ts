import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DependencyLicenseEntry {
  name: string;
  versions: string[];
  paths?: string[];
}

// Exact review and constraints: docs/reviews/claude-sdk-0.3.260.md.
// A future version, changed notice, or newly named package needs a new review.
const reviewedVersion = "0.3.260";
const reviewedNoticeSha256 =
  "8ce94b9478bb9868f9641f818e06cd722fbe55d4c22e2d2ed11971b20146173a";
const reviewedClaudePackages = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "@anthropic-ai/claude-agent-sdk-linux-x64",
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  "@anthropic-ai/claude-agent-sdk-win32-arm64",
  "@anthropic-ai/claude-agent-sdk-win32-x64",
]);

export function isReviewedNonSpdxDependency(
  entry: DependencyLicenseEntry,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  if (
    entry.versions.length !== 1 ||
    entry.versions[0] !== reviewedVersion ||
    !reviewedClaudePackages.has(entry.name) ||
    !entry.paths?.length
  )
    return false;

  try {
    return entry.paths.every((path) => {
      const manifest = JSON.parse(read(join(path, "package.json"))) as {
        name?: string;
        version?: string;
        license?: string;
      };
      const declaredLicense =
        entry.name === "@anthropic-ai/claude-agent-sdk"
          ? "SEE LICENSE IN README.md"
          : "SEE LICENSE IN LICENSE.md";
      return (
        manifest.name === entry.name &&
        manifest.version === reviewedVersion &&
        manifest.license === declaredLicense &&
        createHash("sha256")
          .update(read(join(path, "LICENSE.md")))
          .digest("hex") === reviewedNoticeSha256
      );
    });
  } catch {
    // Missing or malformed evidence is not an approval. Never log file contents.
    return false;
  }
}
