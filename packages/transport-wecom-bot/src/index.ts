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
import type { TemplateCard } from "@wecom/aibot-node-sdk";
import type {
  AgentMediaOutput,
  ChannelTransport,
  ChannelCapability,
  ChannelFeedbackEvent,
  ChannelEnterChatEvent,
  DeliveryReceipt,
  InboundMessage,
  MaterializedInboundMessage,
  MediaType,
  MessagePart,
  OutboundCommand,
  Presentation,
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
  replyStreamNonBlocking(
    frame: WeComFrame,
    streamId: string,
    content: string,
    finish: boolean,
    msgItem?: unknown[],
    feedback?: { id: string },
  ): Promise<unknown | "skipped">;
  replyStreamWithCard(
    frame: WeComFrame,
    streamId: string,
    content: string,
    finish: boolean,
    options?: {
      templateCard?: TemplateCard;
      streamFeedback?: { id: string };
    },
  ): Promise<unknown>;
  replyWelcome(frame: WeComFrame, body: unknown): Promise<unknown>;
  sendMessage(chatId: string, message: unknown): Promise<unknown>;
  updateTemplateCard(
    frame: WeComFrame,
    templateCard: TemplateCard,
    userids?: string[],
  ): Promise<unknown>;
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

export interface WeComClientConnectionOptions {
  botId: string;
  secret: string;
  logger: WeComSdkLogger;
  wsUrl?: string;
  requestTimeout?: number;
  reconnectInterval?: number;
  maxReconnectAttempts: number;
  maxAuthFailureAttempts?: number;
  maxReplyQueueSize?: number;
}

export interface WeComBotTransportOptions {
  accountId: string;
  botId: string;
  secret: string;
  clientFactory?: (options: WeComClientConnectionOptions) => WeComClient;
  /** Official or private-deployment WebSocket endpoint. HTTPS downgrade is forbidden. */
  wsUrl?: string;
  requestTimeoutMs?: number;
  reconnectIntervalMs?: number;
  /** -1 retries forever. The Gateway default is infinite to avoid a live-but-stuck process. */
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
  maxReplyQueueSize?: number;
  onError?: (error: Error) => void;
  onStateChange?: (state: "authenticated" | "disconnected") => void;
  onSdkLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
  /** Privacy-safe notice for an upstream frame the Runtime Contract does not support. */
  onUnsupportedFrame?: (event: {
    frameKind: "message" | "event";
    type: string;
  }) => void;
  mediaTempRoot?: string;
  mediaMaxBytes?: number;
  mediaRetentionMs?: number;
  mediaOutputRoots?: readonly string[];
  presentationLinkHosts?: readonly string[];
  /** Static text replied directly to enter_chat; never invokes a Kernel. */
  welcomeText?: string;
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
    "structured-presentation",
    "interactive-presentation",
    "reply-with-presentation",
    "reply-feedback",
    "static-welcome",
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
  private readonly replyStreamModes = new Map<string, "plain" | "combined">();
  private readonly welcomeText?: string;

  constructor(private readonly options: WeComBotTransportOptions) {
    this.welcomeText = validateWelcomeText(options.welcomeText);
    const logger = this.sdkLogger();
    const clientOptions: WeComClientConnectionOptions = {
      botId: options.botId,
      secret: options.secret,
      logger,
      wsUrl: validateWebSocketUrl(options.wsUrl),
      requestTimeout: optionalPositiveInteger(
        options.requestTimeoutMs,
        "WeCom SDK request timeout",
      ),
      reconnectInterval: optionalPositiveInteger(
        options.reconnectIntervalMs,
        "WeCom SDK reconnect interval",
      ),
      maxReconnectAttempts: reconnectAttempts(options.maxReconnectAttempts),
      maxAuthFailureAttempts: optionalAttempts(
        options.maxAuthFailureAttempts,
        "WeCom SDK auth failure attempts",
      ),
      maxReplyQueueSize: optionalPositiveInteger(
        options.maxReplyQueueSize,
        "WeCom SDK reply queue size",
      ),
    };
    this.client = options.clientFactory
      ? options.clientFactory(clientOptions)
      : (new WSClient(clientOptions) as unknown as WeComClient);
  }

  async start(
    onMessage: (message: InboundMessage) => Promise<void>,
    onFeedback?: (event: ChannelFeedbackEvent) => Promise<void>,
    onEnterChat?: (event: ChannelEnterChatEvent) => Promise<boolean>,
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
        const message = this.normalize(frame);
        if (!message) return;
        void onMessage(message).catch((error: unknown) =>
          this.reportError(error),
        );
      } catch (error) {
        this.reportError(error);
      }
    });
    this.client.on("event", (frame: WeComFrame) => {
      const type = eventType(frame.body);
      if (
        type === "enter_chat" ||
        type === "template_card_event" ||
        type === "feedback_event" ||
        type === "disconnected_event"
      ) {
        return;
      }
      this.reportUnsupportedFrame("event", type);
    });
    this.client.on("event.template_card_event", (frame: WeComFrame) => {
      try {
        void onMessage(this.normalizeInteraction(frame)).catch(
          (error: unknown) => this.reportError(error),
        );
      } catch (error) {
        this.reportError(error);
      }
    });
    this.client.on("event.feedback_event", (frame: WeComFrame) => {
      if (!onFeedback) return;
      try {
        void onFeedback(this.normalizeFeedback(frame)).catch((error: unknown) =>
          this.reportError(error),
        );
      } catch (error) {
        this.reportError(error);
      }
    });
    this.client.on("event.enter_chat", (frame: WeComFrame) => {
      if (!this.welcomeText) return;
      void (async () => {
        if (!onEnterChat) return;
        const allowed = await onEnterChat(this.normalizeContextEvent(frame));
        if (!allowed) return;
        await this.client.replyWelcome(frame, {
          msgtype: "text",
          text: { content: this.welcomeText },
        });
      })().catch((error: unknown) => this.reportError(error));
    });
    await this.client.connect();
  }

  async stop(): Promise<void> {
    this.client.disconnect();
    this.connected = false;
    this.replyStreamModes.clear();
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.connected
      ? { ok: true }
      : { ok: false, detail: "WebSocket is not authenticated" };
  }

  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    if (command.type === "reply") {
      const existingMode = this.replyStreamModes.get(command.streamId);
      const streamMode =
        existingMode ?? (command.presentation ? "combined" : "plain");
      if (!existingMode && !command.final) {
        this.replyStreamModes.set(command.streamId, streamMode);
      }
      try {
        const frame = {
          headers: { req_id: command.replyReference.requestId },
        };
        if (streamMode === "combined") {
          // Combined streams are fixed by their first frame. The official API
          // permits exactly one template_card, so later frames omit it.
          await this.client.replyStreamWithCard(
            frame,
            command.streamId,
            command.text,
            command.final,
            command.presentation && !existingMode
              ? {
                  templateCard: renderWeComTemplateCard(
                    command.presentation,
                    this.options.presentationLinkHosts,
                  ),
                  streamFeedback: { id: command.streamId },
                }
              : !existingMode
                ? { streamFeedback: { id: command.streamId } }
                : undefined,
          );
          if (command.presentation && existingMode) {
            await this.client.sendMessage(command.conversationId, {
              msgtype: "template_card",
              template_card: renderWeComTemplateCard(
                command.presentation,
                this.options.presentationLinkHosts,
              ),
            });
          }
        } else {
          // The official helper skips a partial while the previous ack is
          // pending, preventing stale incremental frames from queueing. Final
          // frames are never skipped by the SDK.
          await this.client.replyStreamNonBlocking(
            frame,
            command.streamId,
            command.text,
            command.final,
            undefined,
            !existingMode ? { id: command.streamId } : undefined,
          );
          // A presentation discovered after a plain stream started cannot be
          // added to that stream. Preserve visibility through a separate Bot
          // message instead of switching vendor message type mid-stream.
          if (command.presentation) {
            await this.client.sendMessage(command.conversationId, {
              msgtype: "template_card",
              template_card: renderWeComTemplateCard(
                command.presentation,
                this.options.presentationLinkHosts,
              ),
            });
          }
        }
        if (command.final) this.replyStreamModes.delete(command.streamId);
      } catch (error) {
        if (!hasErrorCode(error, 846608)) throw error;
        // The official plugin confirms 846608 means the six-minute stream update
        // window expired. Ignore stale partials and proactively send the final text.
        if (command.final) {
          await this.client.sendMessage(command.conversationId, {
            msgtype: "markdown",
            markdown: { content: command.text },
          });
          if (command.presentation) {
            await this.client.sendMessage(command.conversationId, {
              msgtype: "template_card",
              template_card: renderWeComTemplateCard(
                command.presentation,
                this.options.presentationLinkHosts,
              ),
            });
          }
          this.replyStreamModes.delete(command.streamId);
        }
      }
    } else if (command.type === "proactive") {
      await this.client.sendMessage(command.conversationId, {
        msgtype: "markdown",
        markdown: { content: command.text },
      });
    } else if (command.type === "proactive-presentation") {
      await this.client.sendMessage(command.conversationId, {
        msgtype: "template_card",
        template_card: renderWeComTemplateCard(
          command.presentation,
          this.options.presentationLinkHosts,
        ),
      });
    } else if (command.type === "interaction-update") {
      await this.client.updateTemplateCard(
        { headers: { req_id: command.replyReference.requestId } },
        renderWeComInteractionUpdateCard(
          command.presentation,
          this.options.presentationLinkHosts,
        ),
      );
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
    if (
      ![...message.parts, ...(message.quote?.parts ?? [])].some(
        isDownloadableMedia,
      )
    ) {
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
      let partIndex = 0;
      const materializeParts = async (
        source: MessagePart[],
      ): Promise<MessagePart[]> => {
        const parts: MessagePart[] = [];
        for (const part of source) {
          const index = partIndex++;
          if (!isDownloadableMedia(part)) {
            parts.push(part);
            continue;
          }
          const downloaded = await this.client.downloadFile(
            part.url,
            part.aesKey,
          );
          totalBytes += downloaded.buffer.length;
          const maxBytes =
            this.options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
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
        return parts;
      };
      const parts = await materializeParts(message.parts);
      const quote = message.quote
        ? { parts: await materializeParts(message.quote.parts) }
        : undefined;
      return { message: { ...message, parts, quote }, release };
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

  private normalize(frame: WeComFrame): InboundMessage | undefined {
    const body = frame.body ?? {};
    const parts = normalizeParts(body);
    if (!parts) {
      this.reportUnsupportedFrame(
        "message",
        stringValue(body.msgtype) ?? "missing",
      );
      return undefined;
    }
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
      parts,
      quote: normalizeQuote(body.quote),
      replyReference: { requestId },
      metadata: { msgtype: body.msgtype, chattype: body.chattype },
    };
  }

  private normalizeInteraction(frame: WeComFrame): InboundMessage {
    const body = frame.body ?? {};
    const eventContainer = asRecord(body.event);
    const nested = asRecord(eventContainer.template_card_event);
    const event = Object.keys(nested).length > 0 ? nested : eventContainer;
    const interactionId = stringValue(event.task_id);
    if (!interactionId)
      throw new Error("WeCom template card event has no task_id");
    const from = asRecord(body.from);
    const senderId =
      stringValue(from.userid) ?? stringValue(body.userid) ?? "unknown";
    const messageId = stringValue(body.msgid) ?? generateReqId("interaction");
    const chatId = stringValue(body.chatid);
    const chatType = stringValue(body.chattype);
    const isGroup = chatType === "group" || (!chatType && Boolean(chatId));
    if (isGroup && !chatId) {
      throw new Error("WeCom group interaction has no chatid");
    }
    const requestId = frame.headers?.req_id;
    if (!requestId) throw new Error("WeCom template card event has no req_id");
    return {
      id: messageId,
      accountId: this.options.accountId,
      conversationId: isGroup ? chatId! : senderId,
      conversationType: isGroup ? "group" : "direct",
      senderId,
      receivedAt: timestamp(body.create_time),
      parts: [],
      interaction: {
        presentationId: interactionId,
        actionId: stringValue(event.event_key),
        selections: normalizeSelections(event),
      },
      replyReference: { requestId },
      metadata: { msgtype: "event", eventtype: "template_card_event" },
    };
  }

  private normalizeFeedback(frame: WeComFrame): ChannelFeedbackEvent {
    const body = frame.body ?? {};
    const eventContainer = asRecord(body.event);
    const nested = asRecord(eventContainer.feedback_event);
    const event = Object.keys(nested).length > 0 ? nested : eventContainer;
    return {
      ...this.normalizeContextEvent(frame),
      feedbackId:
        stringValue(event.feedback_id) ??
        stringValue(event.feedbackid) ??
        stringValue(event.id),
    };
  }

  private normalizeContextEvent(frame: WeComFrame): ChannelEnterChatEvent {
    const body = frame.body ?? {};
    const from = asRecord(body.from);
    const senderId =
      stringValue(from.userid) ?? stringValue(body.userid) ?? "unknown";
    const chatId = stringValue(body.chatid);
    const chatType = stringValue(body.chattype);
    const isGroup = chatType === "group" || (!chatType && Boolean(chatId));
    if (isGroup && !chatId) {
      throw new Error("WeCom channel event has no chatid");
    }
    return {
      id: stringValue(body.msgid) ?? generateReqId("channel-event"),
      accountId: this.options.accountId,
      conversationId: isGroup ? chatId! : senderId,
      conversationType: isGroup ? "group" : "direct",
      senderId,
      receivedAt: timestamp(body.create_time),
    };
  }

  private reportError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private reportUnsupportedFrame(
    frameKind: "message" | "event",
    type: string,
  ): void {
    this.options.onUnsupportedFrame?.({
      frameKind,
      type: diagnosticFrameType(type),
    });
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
const MAX_WELCOME_BYTES = 2_048;

function validateWelcomeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error("WeCom welcome text must not be empty");
  if (Buffer.byteLength(normalized, "utf8") > MAX_WELCOME_BYTES) {
    throw new Error(
      `WeCom welcome text exceeds ${MAX_WELCOME_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

function validateWebSocketUrl(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WeCom WebSocket URL is invalid");
  }
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "WeCom WebSocket URL must use wss and must not contain credentials, query, or fragment",
    );
  }
  return url.toString();
}

function optionalPositiveInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function optionalAttempts(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < -1 || value === 0) {
    throw new Error(`${label} must be -1 or a positive integer`);
  }
  return value;
}

function reconnectAttempts(value: number | undefined): number {
  return optionalAttempts(value ?? -1, "WeCom SDK reconnect attempts")!;
}

function normalizeParts(
  body: Record<string, unknown>,
): MessagePart[] | undefined {
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
  return undefined;
}

function normalizeQuote(value: unknown): InboundMessage["quote"] {
  const quote = asRecord(value);
  if (Object.keys(quote).length === 0) return undefined;
  const parts = normalizeParts(quote);
  if (!parts) return undefined;
  return { parts };
}

function eventType(body: Record<string, unknown> | undefined): string {
  const event = asRecord(asRecord(body).event);
  return stringValue(event.eventtype) ?? "missing";
}

function diagnosticFrameType(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "unknown";
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

export function renderWeComTemplateCard(
  presentation: Presentation,
  allowedLinkHosts?: readonly string[],
): TemplateCard {
  assertPresentationId(presentation.id);
  const base = {
    task_id: presentation.id,
    main_title: { title: bounded(presentation.title, 26, "title") },
  };
  if (presentation.kind === "notice") {
    return {
      ...base,
      card_type: "text_notice",
      sub_title_text: optionalBounded(presentation.body, 112, "body"),
      ...(presentation.action
        ? {
            card_action: linkAction(presentation.action.url, allowedLinkHosts),
          }
        : {}),
    };
  }
  if (presentation.kind === "article") {
    return {
      ...base,
      card_type: "news_notice",
      sub_title_text: optionalBounded(
        presentation.description,
        112,
        "description",
      ),
      card_image: {
        url: safeHttpsUrl(presentation.imageUrl, allowedLinkHosts),
      },
      card_action: linkAction(presentation.action.url, allowedLinkHosts),
    };
  }
  if (presentation.kind === "actions") {
    if (presentation.actions.length < 1 || presentation.actions.length > 6) {
      throw new Error("Action cards require between 1 and 6 actions");
    }
    uniqueIds(
      presentation.actions.map((action) => action.id),
      "action",
    );
    return {
      ...base,
      card_type: "button_interaction",
      sub_title_text: optionalBounded(presentation.body, 112, "body"),
      button_list: presentation.actions.map((action) => ({
        key: boundedId(action.id, "action"),
        text: bounded(action.label, 10, "action label"),
        style:
          action.style === "danger" ? 4 : action.style === "default" ? 2 : 1,
      })),
    };
  }
  if (presentation.kind === "choice") {
    if (presentation.options.length < 1 || presentation.options.length > 20) {
      throw new Error("Choice cards require between 1 and 20 options");
    }
    uniqueIds(
      presentation.options.map((option) => option.id),
      "option",
    );
    return {
      ...base,
      card_type: "vote_interaction",
      sub_title_text: optionalBounded(presentation.body, 112, "body"),
      checkbox: {
        question_key: boundedId(presentation.questionId, "question"),
        mode: presentation.multiple ? 1 : 0,
        option_list: presentation.options.map((option) => ({
          id: boundedId(option.id, "option"),
          // The official SDK describes 11 characters as a recommendation, not
          // a protocol maximum. Preserve the user's label and let the vertical
          // vote layout wrap it instead of silently truncating meaning.
          text: bounded(option.label, 100, "option label"),
        })),
      },
      submit_button: {
        key: "submit",
        text: bounded(presentation.submitLabel ?? "提交", 10, "submit label"),
      },
    };
  }
  if (presentation.fields.length < 1 || presentation.fields.length > 3) {
    throw new Error("Form cards require between 1 and 3 fields");
  }
  uniqueIds(
    presentation.fields.map((field) => field.id),
    "field",
  );
  return {
    ...base,
    card_type: "multiple_interaction",
    sub_title_text: optionalBounded(presentation.body, 112, "body"),
    select_list: presentation.fields.map((field) => {
      if (field.options.length < 1 || field.options.length > 10) {
        throw new Error("Form fields require between 1 and 10 options");
      }
      uniqueIds(
        field.options.map((option) => option.id),
        "option",
      );
      return {
        question_key: boundedId(field.id, "field"),
        title: bounded(field.label, 13, "field label"),
        option_list: field.options.map((option) => ({
          id: boundedId(option.id, "option"),
          text: bounded(option.label, 10, "option label"),
        })),
      };
    }),
    submit_button: {
      key: boundedId(presentation.submitId, "submit"),
      text: bounded(presentation.submitLabel ?? "提交", 10, "submit label"),
    },
  };
}

/**
 * The intelligent-Bot update endpoint rejects a no-link text_notice with
 * errcode 42045, both with card_action omitted and with {type: 0}. Render an
 * inert result state using the SDK's update-only checkbox.disable capability.
 */
function renderWeComInteractionUpdateCard(
  presentation: Presentation,
  allowedLinkHosts?: readonly string[],
): TemplateCard {
  if (presentation.kind !== "notice" || presentation.action) {
    return renderWeComTemplateCard(presentation, allowedLinkHosts);
  }
  assertPresentationId(presentation.id);
  const result = interactionResultCopy(presentation.body);
  return {
    task_id: presentation.id,
    card_type: "vote_interaction",
    main_title: { title: bounded(result.title, 26, "title") },
    sub_title_text: optionalBounded(presentation.body, 112, "body"),
    checkbox: {
      question_key: "result",
      disable: true,
      mode: 0,
      option_list: [
        {
          id: "completed",
          text: bounded(result.detail, 100, "result detail"),
          is_checked: true,
        },
      ],
    },
    // The real update endpoint requires submit_button even when every choice
    // is disabled (errcode 42049 when omitted). Repeated callbacks remain
    // harmless because the durable Broker has already resolved the task.
    submit_button: {
      key: "completed",
      text: bounded(result.button, 10, "result button"),
    },
  };
}

function interactionResultCopy(body?: string): {
  title: string;
  detail: string;
  button: string;
} {
  const detail = body?.trim() || "操作已处理。";
  if (detail.includes("已批准")) {
    return { title: "✅ 操作已批准", detail, button: "已批准" };
  }
  if (detail.includes("已拒绝")) {
    return { title: "⛔ 操作已拒绝", detail, button: "已拒绝" };
  }
  if (
    detail.includes("不存在") ||
    detail.includes("已失效") ||
    detail.includes("不属于")
  ) {
    return {
      title: "⚠️ 操作已失效",
      detail: "操作已失效、已处理，或不属于当前会话。",
      button: "已失效",
    };
  }
  if (detail.includes("正在停止")) {
    return { title: "⏹️ 正在停止", detail, button: "停止中" };
  }
  if (detail.includes("已经结束") || detail.includes("无需停止")) {
    return { title: "任务已结束", detail, button: "已结束" };
  }
  if (detail.includes("已提交")) {
    return { title: "✅ 已提交", detail, button: "已提交" };
  }
  return { title: "操作结果", detail, button: "已处理" };
}

function normalizeSelections(
  event: Record<string, unknown>,
): Array<{ fieldId: string; optionIds: string[] }> | undefined {
  const selected = asRecord(asRecord(event.selected_items).selected_item);
  const raw = Array.isArray(asRecord(event.selected_items).selected_item)
    ? (asRecord(event.selected_items).selected_item as unknown[])
    : Object.keys(selected).length > 0
      ? [selected]
      : [];
  const selections = raw.flatMap((item) => {
    const record = asRecord(item);
    const fieldId = stringValue(record.question_key);
    if (!fieldId) return [];
    const optionIds = asRecord(record.option_ids).option_id;
    return [
      {
        fieldId,
        optionIds: Array.isArray(optionIds)
          ? optionIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      },
    ];
  });
  return selections.length > 0 ? selections : undefined;
}

function assertPresentationId(id: string): void {
  if (!/^[A-Za-z0-9_@-]{1,128}$/.test(id)) {
    throw new Error("Presentation id contains unsupported characters");
  }
}

function boundedId(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(value)) {
    throw new Error(`${name} id contains unsupported characters`);
  }
  return value;
}

function uniqueIds(ids: string[], name: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${name} ids must be unique`);
  }
}

function bounded(value: string, maxCharacters: number, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if ([...trimmed].length > maxCharacters) {
    throw new Error(`${name} exceeds ${maxCharacters} characters`);
  }
  return trimmed;
}

function optionalBounded(
  value: string | undefined,
  maxCharacters: number,
  name: string,
): string | undefined {
  return value === undefined ? undefined : bounded(value, maxCharacters, name);
}

function linkAction(
  url: string,
  allowedLinkHosts?: readonly string[],
): { type: 1; url: string } {
  return { type: 1, url: safeHttpsUrl(url, allowedLinkHosts) };
}

function safeHttpsUrl(
  value: string,
  allowedLinkHosts?: readonly string[],
): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Presentation links must use credential-free HTTPS URLs");
  }
  if (
    allowedLinkHosts &&
    !allowedLinkHosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error("Presentation link host is not allowed");
  }
  return url.toString();
}
