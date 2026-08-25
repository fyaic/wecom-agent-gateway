import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type {
  AgentMediaOutput,
  ChannelTransport,
  ChannelCapability,
  DeliveryReceipt,
  InboundMessage,
  MaterializedInboundMessage,
  MediaType,
  MessagePart,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";

interface WeComFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

interface WeComClient {
  connect(): Promise<unknown>;
  disconnect(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  replyStream(
    frame: WeComFrame,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<unknown>;
  sendMessage(chatId: string, message: unknown): Promise<unknown>;
  sendMediaMessage(
    chatId: string,
    mediaType: WeComMediaType,
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<unknown>;
  downloadFile(
    url: string,
    aesKey?: string,
  ): Promise<{ buffer: Buffer; filename?: string }>;
  uploadMedia(
    buffer: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<{
    media_id: string;
    type: WeComMediaType;
    created_at: string;
  }>;
}

type WeComMediaType = "file" | "image" | "voice" | "video";

interface WeComSdkLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface WeComBotTransportOptions {
  accountId: string;
  botId: string;
  secret: string;
  clientFactory?: (options: {
    botId: string;
    secret: string;
    logger: WeComSdkLogger;
  }) => WeComClient;
  onError?: (error: Error) => void;
  onStateChange?: (state: "authenticated" | "disconnected") => void;
  onSdkLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
  mediaTempRoot?: string;
  mediaMaxBytes?: number;
  mediaRetentionMs?: number;
  mediaOutputRoots?: readonly string[];
}

export class WeComBotTransport implements ChannelTransport {
  readonly id = "wecom-bot";
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    "stream-reply-update",
    "proactive-message",
    "media-download",
    "media-upload",
    "multimodal-input",
    "multimodal-output",
  ]);
  readonly inputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "video",
    "file",
  ]);
  readonly outputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "audio",
    "video",
    "file",
  ]);
  private readonly client: WeComClient;
  private connected = false;

  constructor(private readonly options: WeComBotTransportOptions) {
    const logger = this.sdkLogger();
    this.client = options.clientFactory
      ? options.clientFactory({
          botId: options.botId,
          secret: options.secret,
          logger,
        })
      : (new WSClient({
          botId: options.botId,
          secret: options.secret,
          logger,
        }) as unknown as WeComClient);
  }

  async start(
    onMessage: (message: InboundMessage) => Promise<void>,
  ): Promise<void> {
    await this.cleanupOrphanedMedia();
    this.client.on("authenticated", () => {
      this.connected = true;
      this.options.onStateChange?.("authenticated");
    });
    this.client.on("disconnected", () => {
      this.connected = false;
      this.options.onStateChange?.("disconnected");
    });
    this.client.on("error", (error: unknown) => this.reportError(error));
    this.client.on("message", (frame: WeComFrame) => {
      try {
        void onMessage(this.normalize(frame)).catch((error: unknown) =>
          this.reportError(error),
        );
      } catch (error) {
        this.reportError(error);
      }
    });
    await this.client.connect();
  }

  async stop(): Promise<void> {
    this.client.disconnect();
    this.connected = false;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.connected
      ? { ok: true }
      : { ok: false, detail: "WebSocket is not authenticated" };
  }

  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    if (command.type === "reply") {
      try {
        await this.client.replyStream(
          { headers: { req_id: command.replyReference.requestId } },
          command.streamId,
          command.text,
          command.final,
        );
      } catch (error) {
        if (!hasErrorCode(error, 846608)) throw error;
        // The official plugin confirms 846608 means the six-minute stream update
        // window expired. Ignore stale partials and proactively send the final text.
        if (command.final) {
          await this.client.sendMessage(command.conversationId, {
            msgtype: "markdown",
            markdown: { content: command.text },
          });
        }
      }
    } else if (command.type === "proactive") {
      await this.client.sendMessage(command.conversationId, {
        msgtype: "markdown",
        markdown: { content: command.text },
      });
    } else {
      const outbound = await this.loadOutboundMedia(command.media);
      const uploaded = await this.client.uploadMedia(outbound.buffer, {
        type: outbound.type,
        filename: outbound.filename,
      });
      await this.client.sendMediaMessage(
        command.conversationId,
        outbound.type,
        uploaded.media_id,
        outbound.type === "video"
          ? {
              title: command.media.title,
              description: command.media.description,
            }
          : undefined,
      );
    }
    return {
      id: generateReqId("delivery"),
      acceptedAt: new Date().toISOString(),
    };
  }

  async materializeInbound(
    message: InboundMessage,
  ): Promise<MaterializedInboundMessage> {
    if (!message.parts.some(isDownloadableMedia)) {
      return { message, release: async () => undefined };
    }

    const root = this.mediaTempRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, MEDIA_DIRECTORY_PREFIX));
    await chmod(directory, 0o700);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await rm(directory, { recursive: true, force: true });
    };

    try {
      let totalBytes = 0;
      const parts: MessagePart[] = [];
      for (const [index, part] of message.parts.entries()) {
        if (!isDownloadableMedia(part)) {
          parts.push(part);
          continue;
        }
        const downloaded = await this.client.downloadFile(
          part.url,
          part.aesKey,
        );
        totalBytes += downloaded.buffer.length;
        const maxBytes = this.options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
        if (downloaded.buffer.length > maxBytes || totalBytes > maxBytes) {
          throw new Error(
            `Inbound ${part.type} exceeds configured media limit (${maxBytes} bytes)`,
          );
        }
        const name = safeMediaName(
          downloaded.filename ?? part.name,
          part.type,
          index,
        );
        const path = join(directory, name);
        await writeFile(path, downloaded.buffer, { mode: 0o600, flag: "wx" });
        parts.push({
          type: part.type,
          path,
          name,
          mimeType: detectMime(downloaded.buffer, name),
          sizeBytes: downloaded.buffer.length,
        });
      }
      return { message: { ...message, parts }, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async downloadMedia(
    url: string,
    aesKey?: string,
  ): Promise<{ buffer: Buffer; filename?: string }> {
    return this.client.downloadFile(url, aesKey);
  }

  async uploadMedia(
    buffer: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<{
    media_id: string;
    type: WeComMediaType;
    created_at: string;
  }> {
    return this.client.uploadMedia(buffer, options);
  }

  private normalize(frame: WeComFrame): InboundMessage {
    const body = frame.body ?? {};
    const from = asRecord(body.from);
    const senderId =
      stringValue(from.userid) ?? stringValue(body.userid) ?? "unknown";
    const messageId = stringValue(body.msgid) ?? generateReqId("inbound");
    const chatId = stringValue(body.chatid);
    const chatType = stringValue(body.chattype);
    const isGroup = chatType === "group" || (!chatType && Boolean(chatId));
    if (isGroup && !chatId) {
      throw new Error("WeCom group message has no chatid");
    }
    const requestId = frame.headers?.req_id;
    if (!requestId) throw new Error("WeCom message has no req_id");
    return {
      id: messageId,
      accountId: this.options.accountId,
      conversationId: isGroup ? chatId! : senderId,
      conversationType: isGroup ? "group" : "direct",
      senderId,
      receivedAt: timestamp(body.create_time),
      parts: normalizeParts(body),
      replyReference: { requestId },
      metadata: { msgtype: body.msgtype, chattype: body.chattype },
    };
  }

  private reportError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private sdkLogger(): WeComSdkLogger {
    const emit =
      (level: "debug" | "info" | "warn" | "error") =>
      (message: string): void =>
        this.options.onSdkLog?.(level, String(message));
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
    };
  }

  private mediaTempRoot(): string {
    return this.options.mediaTempRoot ?? tmpdir();
  }

  private async cleanupOrphanedMedia(): Promise<void> {
    const root = this.mediaTempRoot();
    const retentionMs =
      this.options.mediaRetentionMs ?? DEFAULT_MEDIA_RETENTION_MS;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (asRecord(error).code === "ENOENT") return;
      throw error;
    }
    const cutoff = Date.now() - retentionMs;
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith(MEDIA_DIRECTORY_PREFIX),
        )
        .map(async (entry) => {
          const path = join(root, entry.name);
          const metadata = await stat(path);
          if (metadata.mtimeMs < cutoff) {
            await rm(path, { recursive: true, force: true });
          }
        }),
    );
  }

  private async loadOutboundMedia(
    media: AgentMediaOutput,
  ): Promise<{ buffer: Buffer; filename: string; type: WeComMediaType }> {
    const configuredRoots = this.options.mediaOutputRoots ?? [];
    if (configuredRoots.length === 0) {
      throw new Error("Outbound media is disabled: no allowed output roots");
    }
    const candidate = await realpath(media.path);
    const allowedRoots = await Promise.all(
      configuredRoots.map(async (root) => {
        const path = await realpath(root);
        const metadata = await stat(path);
        if (!metadata.isDirectory()) {
          throw new Error("Outbound media root is not a directory");
        }
        return path;
      }),
    );
    const allowed = allowedRoots.some((root) => {
      const child = relative(root, candidate);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    });
    if (!allowed)
      throw new Error("Outbound media path is outside allowed roots");
    const handle = await open(
      candidate,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("Outbound media path is not a file");
      }
      const maxBytes = Math.min(
        this.options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
        DEFAULT_MEDIA_MAX_BYTES,
      );
      if (metadata.size > maxBytes) {
        throw new Error(
          `Outbound ${media.type} exceeds configured media limit (${maxBytes} bytes)`,
        );
      }
      const buffer = await handle.readFile();
      if (buffer.length > maxBytes) {
        throw new Error(
          `Outbound ${media.type} exceeds configured media limit (${maxBytes} bytes)`,
        );
      }
      if (media.sizeBytes !== undefined && buffer.length !== media.sizeBytes) {
        throw new Error("Outbound media size changed after spooling");
      }
      if (
        media.sha256 !== undefined &&
        createHash("sha256").update(buffer).digest("hex") !== media.sha256
      ) {
        throw new Error("Outbound media integrity changed after spooling");
      }
      return {
        buffer,
        filename: safeUploadFilename(media.name ?? basename(candidate)),
        type: media.type === "audio" ? "voice" : media.type,
      };
    } finally {
      await handle.close();
    }
  }
}

const MEDIA_DIRECTORY_PREFIX = "wecom-agent-gateway-media-";
const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MEDIA_RETENTION_MS = 24 * 60 * 60 * 1_000;

function normalizeParts(body: Record<string, unknown>): MessagePart[] {
  const msgtype = stringValue(body.msgtype);
  if (msgtype === "text") {
    return [
      { type: "text", text: stringValue(asRecord(body.text).content) ?? "" },
    ];
  }
  if (msgtype === "voice") {
    return [
      {
        type: "text",
        text: stringValue(asRecord(body.voice).content) ?? "",
      },
    ];
  }
  if (msgtype === "mixed") {
    const items = asRecord(body.mixed).msg_item;
    return Array.isArray(items)
      ? items.flatMap((item): MessagePart[] => {
          const record = asRecord(item);
          if (record.msgtype === "text") {
            return [
              {
                type: "text",
                text: stringValue(asRecord(record.text).content) ?? "",
              },
            ];
          }
          if (record.msgtype === "image") {
            return [mediaPart("image", asRecord(record.image))];
          }
          return [];
        })
      : [];
  }
  if (msgtype === "image" || msgtype === "video" || msgtype === "file") {
    const payload = asRecord(body[msgtype]);
    return [mediaPart(msgtype, payload)];
  }
  return [{ type: "text", text: "" }];
}

function mediaPart(
  type: "image" | "video" | "file",
  payload: Record<string, unknown>,
): MessagePart {
  return {
    type,
    url: stringValue(payload.url),
    name: stringValue(payload.filename),
    aesKey: stringValue(payload.aeskey),
  };
}

function isDownloadableMedia(part: MessagePart): part is Extract<
  MessagePart,
  { type: "image" | "audio" | "video" | "file" }
> & {
  url: string;
} {
  return part.type !== "text" && Boolean(part.url);
}

function safeMediaName(
  value: string | undefined,
  type: Exclude<MessagePart["type"], "text">,
  index: number,
): string {
  const fallbackExtension =
    type === "image"
      ? ".jpg"
      : type === "audio"
        ? ".m4a"
        : type === "video"
          ? ".mp4"
          : ".bin";
  const candidate = basename(
    value?.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "",
  );
  const usable =
    candidate && candidate !== "." ? candidate : `${type}${fallbackExtension}`;
  const extension = extname(usable).slice(0, 20);
  const rawStem = usable.slice(0, usable.length - extension.length);
  const stem = rawStem.slice(0, Math.max(1, 180 - extension.length));
  return `${index.toString().padStart(2, "0")}-${stem}${extension}`;
}

function safeUploadFilename(value: string): string {
  const candidate = basename(
    value.replace(/[\u0000-\u001f\u007f]/g, "").trim(),
  );
  if (!candidate || candidate === ".") return "attachment.bin";
  const extension = extname(candidate).slice(0, 20);
  const rawStem = candidate.slice(0, candidate.length - extension.length);
  return `${rawStem.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

function detectMime(buffer: Buffer, filename: string): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
    buffer.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return extname(filename).toLowerCase() === ".m4a"
      ? "audio/mp4"
      : "video/mp4";
  }
  const extension = extname(filename).toLowerCase();
  return {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
  }[extension];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : new Date().toISOString();
}

function hasErrorCode(error: unknown, code: number): boolean {
  const record = asRecord(error);
  const message = `${stringValue(record.errmsg) ?? ""} ${
    stringValue(record.message) ?? ""
  }`;
  return record.errcode === code || message.includes(String(code));
}
