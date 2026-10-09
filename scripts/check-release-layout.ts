import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { SqliteGatewayStore } from "../packages/storage-sqlite/src/index.js";
import { createStarterConfig, setup } from "./setup.js";

// Acceptance fixture only. No caller-supplied paths, process execution or credentials.
export async function checkReleaseLayout(
  log: (event: {
    stage: string;
    passed: true;
    evidence: string;
  }) => void = console.log,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wecom-release-layout-"));
  const require = (condition: boolean, code: string) => {
    if (!condition) throw new Error(code);
  };
  const pass = (stage: string) =>
    log({ stage, passed: true, evidence: "local-fixture-no-bot-no-model" });
  try {
    const shared = join(root, "shared");
    const state = join(shared, "state");
    const workspace = join(shared, "workspace");
    const releases = [
      join(root, "releases", "old"),
      join(root, "releases", "new"),
    ];
    for (const path of [state, workspace, ...releases])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const configPath = join(shared, "gateway.env");
    const config = [
      createStarterConfig("echo", workspace),
      `GATEWAY_DATABASE_PATH='${join(state, "gateway.db")}'`,
      `GATEWAY_MEDIA_SPOOL_ROOT='${join(state, "media-spool")}'`,
      `GATEWAY_OWNER_LOCK_ROOT='${join(shared, "owner-locks")}'`,
      `GATEWAY_CONTROL_SOCKET='${join(state, "control.sock")}'`,
      "",
    ].join("\n");
    await writeFile(configPath, config, { flag: "wx", mode: 0o600 });
    await writeFile(join(workspace, "user-file.txt"), "keep-workspace", {
      flag: "wx",
    });
    for (const release of releases) {
      await symlink(configPath, join(release, ".env"));
      require((await readFile(join(release, ".env"), "utf8")) ===
        config, "config-changed");
      let rejected = false;
      try {
        await setup(["--adapter", "pi"], release);
      } catch (error) {
        rejected =
          error instanceof Error &&
          error.message.includes(".env already exists");
      }
      require(rejected, "setup-did-not-refuse-existing-config");
    }
    const parsed = parseEnv(await readFile(configPath, "utf8"));
    require(parsed.WECOM_BOT_ID === "" &&
      parsed.WECOM_BOT_SECRET === "", "unexpected-credentials");
    require(parsed.AGENT_WORKING_DIRECTORY === workspace, "workspace-moved");
    require(((await lstat(configPath)).mode & 0o777) ===
      0o600, "config-not-private");
    require((await readFile(configPath, "utf8")) ===
      config, "config-overwritten");
    pass("shared-private-config-survives-two-release-directories");

    const danglingRelease = join(root, "dangling-release");
    await mkdir(danglingRelease);
    await symlink(join(root, "missing"), join(danglingRelease, ".env"));
    let danglingRejected = false;
    try {
      await setup(["--adapter", "echo"], danglingRelease);
    } catch (error) {
      danglingRejected =
        error instanceof Error && error.message.includes(".env already exists");
    }
    require(danglingRejected, "dangling-config-overwritten");
    require((
      await lstat(join(danglingRelease, ".env"))
    ).isSymbolicLink(), "dangling-link-replaced");
    pass("dangling-config-is-not-overwritten");

    const message: InboundMessage = {
      id: "before-upgrade",
      accountId: "fixture-bot",
      conversationId: "fixture-chat",
      conversationType: "direct",
      senderId: "fixture-user",
      receivedAt: "2026-09-23T00:00:00.000Z",
      parts: [{ type: "text", text: "fixture" }],
    };
    const scope = {
      accountId: message.accountId,
      conversationId: message.conversationId,
      adapterId: "fixture",
    };
    const original = new SqliteGatewayStore(parsed.GATEWAY_DATABASE_PATH!);
    try {
      await original.acceptInbound(message);
      await original.setSession({ ...scope, sessionId: "before-session" });
      await original.enqueueDelivery({
        messageId: message.id,
        command: {
          type: "proactive",
          accountId: message.accountId,
          conversationId: message.conversationId,
          text: "fixture-only",
        },
        now: message.receivedAt,
      });
    } finally {
      original.close();
    }
    await mkdir(parsed.GATEWAY_MEDIA_SPOOL_ROOT!);
    await writeFile(
      join(parsed.GATEWAY_MEDIA_SPOOL_ROOT!, "fixture.txt"),
      "keep-media",
    );
    // All SQLite handles are closed before copying the whole state, never a live DB.
    const snapshot = join(root, "snapshot");
    await cp(state, snapshot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const upgraded = new SqliteGatewayStore(parsed.GATEWAY_DATABASE_PATH!);
    try {
      require(!(await upgraded.acceptInbound(message)), "dedup-lost-on-reopen");
      require((await upgraded.getSession(scope)) ===
        "before-session", "session-lost-on-reopen");
      await upgraded.acceptInbound({ ...message, id: "after-upgrade" });
      await upgraded.setSession({ ...scope, sessionId: "after-session" });
    } finally {
      upgraded.close();
    }
    pass("closed-sqlite-snapshot-and-same-version-reopen");

    // Restore to another fresh directory, retaining both snapshot and failed state.
    const restoredPath = join(root, "restored");
    await cp(snapshot, restoredPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const restored = new SqliteGatewayStore(join(restoredPath, "gateway.db"));
    try {
      require(!(await restored.acceptInbound(message)), "snapshot-dedup-lost");
      require((await restored.getSession(scope)) ===
        "before-session", "snapshot-session-lost");
      require((await restored.getDeliveryOutboxStats()).pending ===
        1, "snapshot-outbox-lost");
      require(await restored.acceptInbound({
        ...message,
        id: "after-upgrade",
      }), "post-snapshot-event-unexpectedly-present");
    } finally {
      restored.close();
    }
    require((await readFile(
      join(restoredPath, "media-spool", "fixture.txt"),
      "utf8",
    )) === "keep-media", "snapshot-media-lost");
    require((await readFile(join(workspace, "user-file.txt"), "utf8")) ===
      "keep-workspace", "workspace-overwritten");
    require((await readFile(configPath, "utf8")) ===
      config, "private-config-overwritten");
    pass("restore-preserves-snapshot-but-loses-newer-events");

    const futurePath = join(root, "future.db");
    await cp(join(snapshot, "gateway.db"), futurePath, {
      errorOnExist: true,
      force: false,
    });
    const future = new DatabaseSync(futurePath);
    try {
      future.exec("PRAGMA user_version = 999");
    } finally {
      future.close();
    }
    let refused = false;
    try {
      const unsupported = new SqliteGatewayStore(futurePath);
      unsupported.close();
    } catch (error) {
      refused =
        error instanceof Error &&
        error.message.includes("newer than supported");
    }
    require(refused, "future-schema-not-refused");
    pass("newer-sqlite-schema-fails-closed");
  } finally {
    // Only the directory created by this invocation can ever be removed.
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.slice(2).length) throw new Error("no-arguments-supported");
    await checkReleaseLayout((event) => console.log(JSON.stringify(event)));
  } catch {
    console.error(
      JSON.stringify({
        event: "release_layout_failed",
        evidence: "local-fixture-only",
      }),
    );
    process.exitCode = 1;
  }
}
