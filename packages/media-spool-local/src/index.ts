import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentMediaOutput,
  DurableMediaArtifact,
  MediaSpool,
} from "@fyaic/wecom-runtime-contract";

export interface LocalMediaSpoolOptions {
  root: string;
  sourceRoots: readonly string[];
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
}

export class LocalMediaSpool implements MediaSpool {
  readonly id = "local-media-spool";
  readonly rootPath: string;
  private allowedSourceRoots: string[] | undefined;
  private realRoot: string | undefined;
  private operation = Promise.resolve();

  constructor(private readonly options: LocalMediaSpoolOptions) {
    this.rootPath = resolve(options.root);
  }

  async start(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const linkMetadata = await lstat(this.rootPath);
    if (linkMetadata.isSymbolicLink()) {
      throw new Error("Media spool root must not be a symbolic link");
    }
    if (!linkMetadata.isDirectory())
      throw new Error("Media spool root is not a directory");
    await chmod(this.rootPath, 0o700);
    const realRoot = await realpath(this.rootPath);
    this.realRoot = realRoot;
    this.allowedSourceRoots = await Promise.all(
      this.options.sourceRoots.map(async (root) => {
        const path = await realpath(root);
        const sourceMetadata = await stat(path);
        if (!sourceMetadata.isDirectory()) {
          throw new Error("Media spool source root is not a directory");
        }
        return path;
      }),
    );
    if (
      this.allowedSourceRoots.some(
        (root) => isWithin(root, realRoot) || isWithin(realRoot, root),
      )
    ) {
      throw new Error("Media spool root must not overlap allowed source roots");
    }
  }

  async stage(media: AgentMediaOutput): Promise<DurableMediaArtifact> {
    return this.withLock(async () => {
      await this.ensureStarted();
      if (this.allowedSourceRoots?.length === 0) {
        throw new Error("Outbound media is disabled: no allowed source roots");
      }
      const candidate = await realpath(media.path);
      if (!this.isAllowedSource(candidate)) {
        throw new Error("Outbound media path is outside allowed source roots");
      }
      if (this.realRoot && isWithin(this.realRoot, candidate)) {
        throw new Error("Outbound media source must not be inside the spool");
      }
      const source = await open(
        candidate,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let buffer: Buffer;
      try {
        const metadata = await source.stat();
        if (!metadata.isFile())
          throw new Error("Outbound media path is not a file");
        const maxBytes = this.options.maxArtifactBytes ?? 50 * 1024 * 1024;
        if (metadata.size > maxBytes) {
          throw new Error(
            `Outbound media exceeds configured spool artifact limit (${maxBytes} bytes)`,
          );
        }
        buffer = await source.readFile();
        if (buffer.length > maxBytes) {
          throw new Error(
            `Outbound media exceeds configured spool artifact limit (${maxBytes} bytes)`,
          );
        }
      } finally {
        await source.close();
      }

      const totalBytes = await this.currentBytes();
      const maxTotalBytes = this.options.maxTotalBytes ?? 500 * 1024 * 1024;
      if (totalBytes + buffer.length > maxTotalBytes) {
        throw new Error(
          `Media spool exceeds configured total limit (${maxTotalBytes} bytes)`,
        );
      }

      const artifactId = randomUUID();
      const temporary = join(this.rootPath, `.staging-${artifactId}`);
      const destination = join(this.rootPath, artifactId);
      await mkdir(temporary, { mode: 0o700 });
      try {
        const output = await open(
          join(temporary, "data"),
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await output.writeFile(buffer);
        } finally {
          await output.close();
        }
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }

      return {
        artifactId,
        type: media.type,
        name: safeName(media.name ?? basename(candidate)),
        mimeType: media.mimeType,
        title: media.title,
        description: media.description,
        sizeBytes: buffer.length,
        sha256: sha256(buffer),
      };
    });
  }

  async materialize(artifact: DurableMediaArtifact): Promise<AgentMediaOutput> {
    await this.ensureStarted();
    validateArtifactId(artifact.artifactId);
    const path = await realpath(
      join(this.rootPath, artifact.artifactId, "data"),
    );
    if (!this.realRoot || !isWithin(this.realRoot, path)) {
      throw new Error("Media spool artifact escaped configured root");
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new Error("Media spool artifact is not a file");
      if (metadata.size !== artifact.sizeBytes) {
        throw new Error("Media spool artifact size mismatch");
      }
      const buffer = await handle.readFile();
      if (sha256(buffer) !== artifact.sha256) {
        throw new Error("Media spool artifact integrity mismatch");
      }
    } finally {
      await handle.close();
    }
    return {
      type: artifact.type,
      path,
      name: artifact.name,
      mimeType: artifact.mimeType,
      title: artifact.title,
      description: artifact.description,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    };
  }

  async release(artifactId: string): Promise<void> {
    await this.withLock(async () => {
      validateArtifactId(artifactId);
      const path = join(this.rootPath, artifactId);
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          await rm(path, { force: true });
          return;
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      await rm(path, { recursive: true, force: true });
    });
  }

  async reconcile(referencedArtifactIds: ReadonlySet<string>): Promise<void> {
    await this.withLock(async () => {
      await this.ensureStarted();
      const entries = await readdir(this.rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".staging-")) {
          await rm(join(this.rootPath, entry.name), {
            recursive: true,
            force: true,
          });
          continue;
        }
        if (
          ARTIFACT_ID.test(entry.name) &&
          !referencedArtifactIds.has(entry.name)
        ) {
          await rm(join(this.rootPath, entry.name), {
            recursive: true,
            force: true,
          });
        }
      }
    });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.allowedSourceRoots) await this.start();
  }

  private isAllowedSource(candidate: string): boolean {
    return Boolean(
      this.allowedSourceRoots?.some((root) => isWithin(root, candidate)),
    );
  }

  private async currentBytes(): Promise<number> {
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) continue;
      try {
        bytes += (await stat(join(this.rootPath, entry.name, "data"))).size;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    return bytes;
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const ARTIFACT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateArtifactId(artifactId: string): void {
  if (!ARTIFACT_ID.test(artifactId)) {
    throw new Error("Invalid media spool artifact identifier");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function safeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = basename(value).replaceAll("\0", "").slice(0, 255);
  return name || undefined;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
