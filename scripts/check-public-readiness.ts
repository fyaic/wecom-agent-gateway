import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const root = process.cwd();
const failures: string[] = [];

const requiredFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.en.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "docs/evidence-claims.md",
  "scripts/verify-real-wecom-ingress.ts",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`missing:${file}`);
}

const requiredEvidenceDisclosures: Array<[string, string]> = [
  ["README.md", "## 当前证据边界"],
  ["README.md", "原生 `msgtype=video` callback"],
  ["README.en.md", "## Current evidence boundary"],
  ["README.en.md", "Native `msgtype=video` callback"],
  ["ROADMAP.md", "- [ ] Certify native WeCom video callbacks"],
  ["ROADMAP.md", "pnpm verify:real-wecom-ingress"],
  ["docs/status.md", "## 未声称已通过的真实联调"],
  [
    "docs/evidence-claims.md",
    "媒体传输、媒体语义分类和 Agent 理解是三项不同能力",
  ],
];
for (const [file, disclosure] of requiredEvidenceDisclosures) {
  const absolute = resolve(root, file);
  if (
    !existsSync(absolute) ||
    !readFileSync(absolute, "utf8").includes(disclosure)
  ) {
    failures.push(`missing-evidence-disclosure:${file}`);
  }
}

const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as {
  private?: boolean;
  license?: string;
  repository?: unknown;
};
if (packageJson.license !== "MIT") failures.push("package-license:not-mit");
if (packageJson.private !== true) {
  failures.push("package-private:must-prevent-accidental-publish");
}
if (!packageJson.repository) failures.push("package-repository:missing");

for (const workspaceManifest of [
  ...globPackageManifests("apps"),
  ...globPackageManifests("packages"),
]) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, workspaceManifest), "utf8"),
  ) as { private?: boolean; license?: string };
  if (manifest.license !== "MIT") {
    failures.push(`workspace-license:${workspaceManifest}`);
  }
  if (manifest.private !== true) {
    failures.push(`workspace-private:${workspaceManifest}`);
  }
}

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

const forbiddenTracked = tracked.filter((file) => {
  const lower = file.toLowerCase();
  return (
    (lower.startsWith(".env") && lower !== ".env.example") ||
    lower.startsWith("data/") ||
    lower.startsWith("logs/") ||
    /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx)$/.test(lower)
  );
});
for (const file of forbiddenTracked) failures.push(`tracked-private:${file}`);

const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
const privacyPatterns: Array<[string, RegExp]> = [
  ["absolute-macos-user-path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["email-address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["openai-style-token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["github-token", /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{30,}\b/],
];

for (const file of tracked) {
  if (!textExtensions.has(extname(file))) continue;
  const absolute = resolve(root, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  const content = readFileSync(absolute, "utf8");
  for (const [name, pattern] of privacyPatterns) {
    if (pattern.test(content)) failures.push(`${name}:${file}`);
  }
  if (extname(file) === ".md") checkLocalLinks(file, content);
}

const licenseInventory = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
) as Record<string, DependencyLicenseEntry[]>;
const reviewedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);
for (const [license, entries] of Object.entries(licenseInventory)) {
  if (reviewedLicenses.has(license)) continue;
  for (const entry of entries) {
    if (!isReviewedNonSpdxDependency(entry)) {
      failures.push(
        `unreviewed-dependency-license:${license}:${entry.name}@${entry.versions.join(",")}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify({ event: "public_readiness", ok: false, failures }, null, 2),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      event: "public_readiness",
      ok: true,
      trackedFiles: tracked.length,
      dependencyLicenseCategories: Object.keys(licenseInventory).sort(),
    }),
  );
}

function checkLocalLinks(file: string, content: string): void {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim();
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
    ) {
      continue;
    }
    const unwrapped = rawTarget.replace(/^<|>$/g, "");
    const pathOnly = unwrapped.split(/[?#]/, 1)[0];
    if (!pathOnly) continue;
    const target = resolve(root, dirname(file), decodeURIComponent(pathOnly));
    if (!existsSync(target))
      failures.push(`broken-local-link:${file}:${pathOnly}`);
  }
}

function globPackageManifests(parent: string): string[] {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      `${parent}/*/package.json`,
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

interface DependencyLicenseEntry {
  name: string;
  versions: string[];
}

function isReviewedNonSpdxDependency(entry: DependencyLicenseEntry): boolean {
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
  return (
    entry.versions.length === 1 &&
    entry.versions[0] === "0.3.258" &&
    reviewedClaudePackages.has(entry.name)
  );
}
