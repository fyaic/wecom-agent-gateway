import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  ProactiveDeliveryState,
  ProactiveMediaRequest,
  ProactiveTextRequest,
} from "@fyaic/wecom-channel-core";
import type {
  AgentMediaOutput,
  ConversationType,
  MediaType,
} from "@fyaic/wecom-runtime-contract";

export const LOCAL_CONTROL_PROTOCOL_VERSION = 1 as const;

export interface ProactiveTarget {
  alias: string;
  accountId: string;
  conversationId: string;
  conversationType: ConversationType;
}

export interface ScopedProactiveTargetOptions {
  accountId: string;
  allowedDirectSenders: Iterable<string>;
  allowedGroupConversations: Iterable<string>;
  /** Optional alias map; values must already exist in the matching scoped allowlist. */
  aliasesJson?: string;
}

export function createScopedProactiveTargets(
  options: ScopedProactiveTargetOptions,
): ProactiveTarget[] {
  const direct = new Set(options.allowedDirectSenders);
  const group = new Set(options.allowedGroupConversations);
  const targets: ProactiveTarget[] = [];
  if (direct.size === 1) {
    targets.push({
      alias: "direct",
      accountId: options.accountId,
      conversationId: [...direct][0]!,
      conversationType: "direct",
    });
  }
  if (group.size === 1) {
    targets.push({
      alias: "group",
      accountId: options.accountId,
      conversationId: [...group][0]!,
      conversationType: "group",
    });
  }
  if (!options.aliasesJson?.trim()) return targets;

  let parsed: unknown;
  try {
    parsed = JSON.parse(options.aliasesJson);
  } catch {
    throw new Error("GATEWAY_PROACTIVE_TARGETS_JSON must be valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("GATEWAY_PROACTIVE_TARGETS_JSON must be an object");
  }
  for (const [alias, value] of Object.entries(parsed)) {
    if (!isObject(value)) {
      throw new Error("Proactive target entries must be objects");
    }
    const conversationType = value.conversationType;
    const conversationId = value.conversationId;
    if (
      (conversationType !== "direct" && conversationType !== "group") ||
      typeof conversationId !== "string"
    ) {
      throw new Error(
        "Proactive targets require conversationType and conversationId",
      );
    }
    const scoped = conversationType === "direct" ? direct : group;
    if (!scoped.has(conversationId)) {
      throw new Error("Proactive target is outside the scoped allowlist");
    }
    targets.push({
      alias,
      accountId: options.accountId,
      conversationId,
      conversationType,
    });
  }
  const aliases = new Set(targets.map((target) => target.alias));
  if (aliases.size !== targets.length) {
    throw new Error("Proactive target aliases must be unique");
  }
  for (const target of targets) validateTarget(target);
  return targets;
}

export interface ProactiveSender {
  sendProactiveText(
    request: ProactiveTextRequest,
  ): Promise<ProactiveDeliveryState>;
  sendProactiveMedia(
    request: ProactiveMediaRequest,
  ): Promise<ProactiveDeliveryState>;
}

export type LocalControlRequest =
  | {
      version: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      action: "health";
    }
  | {
      version: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      action: "send-text";
      target: string;
      text: string;
    }
  | {
      version: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      action: "send-media";
      target: string;
      media: AgentMediaOutput;
    };

export type LocalControlResponse =
  | { ok: true; action: "health"; ready: true }
  | {
      ok: true;
      action: "send-text" | "send-media";
      state: ProactiveDeliveryState;
      targetType: ConversationType;
    }
  | {
      ok: false;
      error: {
        code:
          | "invalid-request"
          | "unknown-target"
          | "command-rejected"
          | "internal-error";
        message: string;
      };
    };

export interface LocalGatewayControlServerOptions {
  socketPath: string;
  sender: ProactiveSender;
  targets: Iterable<ProactiveTarget>;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export class LocalGatewayControlServer {
  readonly socketPath: string;
  private readonly sender: ProactiveSender;
  private readonly targets: ReadonlyMap<string, ProactiveTarget>;
  private readonly maxRequestBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly onError?: (error: Error) => void;
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private ownsSocket = false;

  constructor(options: LocalGatewayControlServerOptions) {
    if (!isAbsolute(options.socketPath)) {
      throw new Error("Local control socket path must be absolute");
    }
    this.socketPath = resolve(options.socketPath);
    this.sender = options.sender;
    this.maxRequestBytes = positiveInteger(
      options.maxRequestBytes,
      64 * 1024,
      "maxRequestBytes",
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      5_000,
      "requestTimeoutMs",
    );
    this.onError = options.onError;
    const targets = [...options.targets];
    for (const target of targets) validateTarget(target);
    this.targets = new Map(targets.map((target) => [target.alias, target]));
    if (this.targets.size !== targets.length) {
      throw new Error("Local control target aliases must be unique");
    }
    if (this.targets.size === 0) {
      throw new Error("Local control requires at least one proactive target");
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.socketPath);
    const server = createServer({ allowHalfOpen: true }, (socket) =>
      this.accept(socket),
    );
    server.on("error", (error) => this.onError?.(asError(error)));
    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: Error) => rejectStart(error);
        server.once("error", onError);
        server.listen(this.socketPath, () => {
          server.off("error", onError);
          resolveStart();
        });
      });
      this.ownsSocket = true;
      await chmod(this.socketPath, 0o600);
      this.server = server;
    } catch (error) {
      server.close();
      if (this.ownsSocket) {
        this.ownsSocket = false;
        await unlinkSocket(this.socketPath);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    if (this.ownsSocket) {
      this.ownsSocket = false;
      await unlinkSocket(this.socketPath);
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.requestTimeoutMs, () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.maxRequestBytes) {
        oversized = true;
        socket.pause();
        this.writeResponse(socket, invalid("Request exceeds byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      if (oversized) return;
      void this.handle(Buffer.concat(chunks).toString("utf8"))
        .then((response) => this.writeResponse(socket, response))
        .catch((error) => {
          this.onError?.(asError(error));
          this.writeResponse(socket, {
            ok: false,
            error: { code: "internal-error", message: "Command failed" },
          });
        });
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", (error) => this.onError?.(asError(error)));
  }

  private async handle(raw: string): Promise<LocalControlResponse> {
    const line = raw.trim();
    if (!line || line.includes("\n") || line.includes("\r")) {
      return invalid("Expected exactly one JSON request");
    }
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      return invalid("Request must be valid JSON");
    }
    if (!isObject(input) || input.version !== LOCAL_CONTROL_PROTOCOL_VERSION) {
      return invalid("Unsupported local control protocol version");
    }
    if (input.action === "health") {
      return { ok: true, action: "health", ready: true };
    }
    if (input.action !== "send-text" && input.action !== "send-media") {
      return invalid("Unsupported local control action");
    }
    if (typeof input.target !== "string") {
      return invalid("Target alias is required");
    }
    const target = this.targets.get(input.target);
    if (!target) {
      return {
        ok: false,
        error: { code: "unknown-target", message: "Unknown target alias" },
      };
    }
    try {
      const state =
        input.action === "send-text"
          ? await this.sendText(input, target)
          : await this.sendMedia(input, target);
      return {
        ok: true,
        action: input.action,
        state,
        targetType: target.conversationType,
      };
    } catch (error) {
      this.onError?.(asError(error));
      return {
        ok: false,
        error: { code: "command-rejected", message: "Command rejected" },
      };
    }
  }

  private sendText(
    input: Record<string, unknown>,
    target: ProactiveTarget,
  ): Promise<ProactiveDeliveryState> {
    if (typeof input.text !== "string") {
      throw new Error("Text is required");
    }
    return this.sender.sendProactiveText({
      accountId: target.accountId,
      conversationId: target.conversationId,
      text: input.text,
    });
  }

  private sendMedia(
    input: Record<string, unknown>,
    target: ProactiveTarget,
  ): Promise<ProactiveDeliveryState> {
    const media = parseMedia(input.media);
    return this.sender.sendProactiveMedia({
      accountId: target.accountId,
      conversationId: target.conversationId,
      media,
    });
  }

  private writeResponse(socket: Socket, response: LocalControlResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}

export interface LocalGatewayControlClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class LocalGatewayControlClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: LocalGatewayControlClientOptions) {
    if (!isAbsolute(options.socketPath)) {
      throw new Error("Local control socket path must be absolute");
    }
    this.socketPath = resolve(options.socketPath);
    this.timeoutMs = positiveInteger(options.timeoutMs, 5_000, "timeoutMs");
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      64 * 1024,
      "maxResponseBytes",
    );
  }

  request(request: LocalControlRequest): Promise<LocalControlResponse> {
    return new Promise((resolveResponse, rejectResponse) => {
      const socket = createConnection(this.socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy(new Error("Local control request timed out"));
      });
      socket.on("connect", () => {
        socket.end(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxResponseBytes) {
          socket.destroy(
            new Error("Local control response exceeds byte limit"),
          );
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", () => {
        try {
          resolveResponse(
            JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as LocalControlResponse,
          );
        } catch {
          rejectResponse(new Error("Local control returned invalid JSON"));
        }
      });
      socket.on("error", rejectResponse);
    });
  }
}

function parseMedia(input: unknown): AgentMediaOutput {
  if (!isObject(input)) throw new Error("Media is required");
  if (!isMediaType(input.type)) throw new Error("Invalid media type");
  if (typeof input.path !== "string" || !isAbsolute(input.path)) {
    throw new Error("Media path must be absolute");
  }
  const media: AgentMediaOutput = { type: input.type, path: input.path };
  for (const key of ["name", "mimeType", "title", "description"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 1_000) {
      throw new Error(`Invalid media ${key}`);
    }
    media[key] = value;
  }
  return media;
}

function validateTarget(target: ProactiveTarget): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(target.alias)) {
    throw new Error("Invalid local control target alias");
  }
  if (
    !target.accountId ||
    !target.conversationId ||
    target.accountId.length > 512 ||
    target.conversationId.length > 512
  ) {
    throw new Error("Invalid local control target identity");
  }
  if (
    target.conversationType !== "direct" &&
    target.conversationType !== "group"
  ) {
    throw new Error("Invalid local control conversation type");
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) {
      throw new Error("Refusing to replace a non-socket control path");
    }
    if (await canConnect(socketPath)) {
      throw new Error("Another local control server is already listening");
    }
    await unlink(socketPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function unlinkSocket(socketPath: string): Promise<void> {
  try {
    const entry = await lstat(socketPath);
    if (entry.isSocket()) await unlink(socketPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function invalid(message: string): LocalControlResponse {
  return { ok: false, error: { code: "invalid-request", message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaType(value: unknown): value is MediaType {
  return ["image", "audio", "video", "file"].includes(String(value));
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
