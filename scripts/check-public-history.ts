import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = process.cwd();
const failures: Record<string, number> = {};

if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
  failures["shallow-repository"] = 1;
}

const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);
if (commits.length === 0) failures["no-reachable-commits"] = 1;

const identities = git(["log", "--all", "--format=%an%x00%ae%x00%cn%x00%ce"])
  .split("\n")
  .filter(Boolean);
for (const identity of identities) {
  const [, authorEmail, , committerEmail] = identity.split("\0");
  for (const email of [authorEmail, committerEmail]) {
    if (email && !isGitHubNoreply(email)) {
      increment("non-noreply-git-identity");
    }
  }
}

const builtInPatterns: Array<[string, string]> = [
  ["absolute-macos-user-path", String.raw`/Users/[A-Za-z0-9._-]+/`],
  [
    "email-address-in-blob",
    String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  ],
  [
    "known-token-shape",
    String.raw`(sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})`,
  ],
];
for (const [category, pattern] of builtInPatterns) {
  const count = grepHistory(pattern, commits);
  if (count > 0) failures[category] = count;
}

const privateTerms = loadPrivateTerms();
if (privateTerms.length > 0) {
  const pattern = privateTerms.map(escapeExtendedRegex).join("|");
  const blobMatches = grepHistory(pattern, commits);
  if (blobMatches > 0) failures["operator-private-term-in-blob"] = blobMatches;
  const refs = git(["for-each-ref", "--format=%(refname)"]);
  const refMatches = privateTerms.filter((term) => refs.includes(term)).length;
  if (refMatches > 0) failures["operator-private-term-in-ref"] = refMatches;
  const identityMatches = identities.filter((identity) =>
    privateTerms.some((term) => identity.includes(term)),
  ).length;
  if (identityMatches > 0) {
    failures["operator-private-term-in-identity"] = identityMatches;
  }
  const messages = git(["log", "--all", "--format=%B%x00"]);
  const messageMatches = messages
    .split("\0")
    .filter((message) =>
      privateTerms.some((term) => message.includes(term)),
    ).length;
  if (messageMatches > 0) {
    failures["operator-private-term-in-commit-message"] = messageMatches;
  }
}

if (Object.keys(failures).length > 0) {
  console.error(
    JSON.stringify({ event: "public_history_audit", ok: false, failures }),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      event: "public_history_audit",
      ok: true,
      reachableCommits: commits.length,
      refs: git(["for-each-ref", "--format=%(refname)"])
        .split("\n")
        .filter(Boolean).length,
      operatorPrivateTerms: privateTerms.length,
    }),
  );
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function grepHistory(pattern: string, revisions: string[]): number {
  if (revisions.length === 0) return 0;
  const result = spawnSync(
    "git",
    ["grep", "-I", "-l", "-E", pattern, ...revisions, "--", "."],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error("Unable to scan reachable Git blobs");
  }
  return result.stdout.split("\n").filter(Boolean).length;
}

function loadPrivateTerms(): string[] {
  const inline = process.env.PUBLIC_AUDIT_PRIVATE_TERMS ?? "";
  const file = process.env.PUBLIC_AUDIT_PRIVATE_TERMS_FILE;
  const values = [inline, file ? readFileSync(file, "utf8") : ""];
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(/\r?\n/))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function escapeExtendedRegex(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

function increment(category: string): void {
  failures[category] = (failures[category] ?? 0) + 1;
}

function isGitHubNoreply(email: string): boolean {
  const githubSystemNoreply = ["noreply", "github.com"].join(
    String.fromCharCode(64),
  );
  return (
    email.endsWith("@users.noreply.github.com") || email === githubSystemNoreply
  );
}
