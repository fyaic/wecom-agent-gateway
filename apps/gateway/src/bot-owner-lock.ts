import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const OWNER_FILE = "owner.json";

interface OwnerRecord {
  version: 1;
  token: string;
  accountFingerprint: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
}

export class BotOwnerConflictError extends Error {
  constructor(readonly ownerPid?: number) {
    super(
      `Another Gateway process already owns this Bot account${ownerPid ? ` (pid ${ownerPid})` : ""}`,
    );
    this.name = "BotOwnerConflictError";
  }
}

export interface BotOwnerLock {
  readonly path: string;
  release(): Promise<void>;
}

interface AcquireBotOwnerLockOptions {
  accountId: string;
  root?: string;
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
  pid?: number;
  hostname?: string;
}

export async function acquireBotOwnerLock(
  options: AcquireBotOwnerLockOptions,
): Promise<BotOwnerLock> {
  const accountFingerprint = createHash("sha256")
    .update(options.accountId)
    .digest("hex");
  const root = resolve(options.root ?? defaultOwnerLockRoot());
  const lockPath = join(root, `${accountFingerprint}.owner`);
  const reaperPath = `${lockPath}.reaper`;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const ownerHostname = options.hostname ?? hostname();
  const ownerPid = options.pid ?? process.pid;
  const token = randomUUID();

  await mkdir(root, { recursive: true, mode: 0o700 });

  const record: OwnerRecord = {
    version: 1,
    token,
    accountFingerprint,
    hostname: ownerHostname,
    pid: ownerPid,
    acquiredAt: new Date().toISOString(),
  };

  if (!(await tryCreateLock(lockPath, record))) {
    const existing = await inspectLock(lockPath, staleAfterMs, ownerHostname);
    if (!existing.stale) {
      throw new BotOwnerConflictError(existing.record?.pid);
    }

    let ownsReaper = false;
    try {
      try {
        await mkdir(reaperPath, { mode: 0o700 });
        ownsReaper = true;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      if (!ownsReaper) {
        const current = await inspectLock(
          lockPath,
          staleAfterMs,
          ownerHostname,
        );
        throw new BotOwnerConflictError(current.record?.pid);
      }

      const current = await inspectLock(lockPath, staleAfterMs, ownerHostname);
      if (!current.stale) {
        throw new BotOwnerConflictError(current.record?.pid);
      }
      await rm(lockPath, { recursive: true, force: true });
      if (!(await tryCreateLock(lockPath, record))) {
        const replacement = await inspectLock(
          lockPath,
          staleAfterMs,
          ownerHostname,
        );
        throw new BotOwnerConflictError(replacement.record?.pid);
      }
    } finally {
      if (ownsReaper) await rm(reaperPath, { recursive: true, force: true });
    }
  }

  let released = false;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref();

  const releaseSync = () => {
    if (released) return;
    const current = readOwnerRecordSync(lockPath);
    if (current?.token === token)
      rmSync(lockPath, { recursive: true, force: true });
    released = true;
  };
  process.once("exit", releaseSync);

  return {
    path: lockPath,
    async release() {
      if (released) return;
      clearInterval(heartbeat);
      process.removeListener("exit", releaseSync);
      const current = await readOwnerRecord(lockPath);
      if (current?.token === token) {
        await rm(lockPath, { recursive: true, force: true });
      }
      released = true;
    },
  };
}

function defaultOwnerLockRoot(): string {
  let uid = "unknown";
  try {
    uid = String(process.getuid?.() ?? userInfo().uid);
  } catch {
    // A private, per-user fallback still avoids exposing account identifiers.
  }
  return join(tmpdir(), `wecom-agent-gateway-${uid}`);
}

async function tryCreateLock(
  lockPath: string,
  record: OwnerRecord,
): Promise<boolean> {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await writeFile(join(lockPath, OWNER_FILE), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function inspectLock(
  lockPath: string,
  staleAfterMs: number,
  localHostname: string,
): Promise<{ stale: boolean; record?: OwnerRecord }> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { stale: true };
    throw error;
  }
  const record = await readOwnerRecord(lockPath);
  if (record?.hostname === localHostname) {
    return { stale: !isProcessAlive(record.pid), record };
  }
  return {
    stale: Date.now() - lockStat.mtimeMs > staleAfterMs,
    ...(record ? { record } : {}),
  };
}

async function readOwnerRecord(
  lockPath: string,
): Promise<OwnerRecord | undefined> {
  try {
    return parseOwnerRecord(await readFile(join(lockPath, OWNER_FILE), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}

function readOwnerRecordSync(lockPath: string): OwnerRecord | undefined {
  try {
    return parseOwnerRecord(readFileSync(join(lockPath, OWNER_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

function parseOwnerRecord(value: string): OwnerRecord {
  const parsed = JSON.parse(value) as Partial<OwnerRecord>;
  if (
    parsed.version !== 1 ||
    typeof parsed.token !== "string" ||
    typeof parsed.accountFingerprint !== "string" ||
    typeof parsed.hostname !== "string" ||
    !Number.isInteger(parsed.pid) ||
    typeof parsed.acquiredAt !== "string"
  ) {
    throw new SyntaxError("Invalid Bot owner record");
  }
  return parsed as OwnerRecord;
}

function isProcessAlive(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
