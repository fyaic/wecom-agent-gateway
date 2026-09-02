import {
  CHANNEL_TRANSPORT_CONTRACT_VERSION,
  type ChannelCapability,
  type ChannelEnterChatEvent,
  type ChannelFeedbackEvent,
  type ChannelTransport,
  type DeliveryReceipt,
  type InboundMessage,
  type MaterializedInboundMessage,
  type MediaType,
  type OutboundCommand,
} from "@fyaic/wecom-runtime-contract";

export interface LoopbackTransportOptions {
  id?: string;
  now?: () => string;
}

/**
 * In-memory reference implementation of the public Channel Transport SPI.
 * It contains no WeCom types and performs no Agent or Core behavior.
 */
export class LoopbackTransport implements ChannelTransport {
  readonly id: string;
  readonly contractVersion = CHANNEL_TRANSPORT_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<ChannelCapability> = new Set([
    "stream-reply-update",
    "proactive-message",
    "media-download",
    "media-upload",
    "multimodal-input",
    "multimodal-output",
    "structured-presentation",
    "interactive-presentation",
    "reply-feedback",
    "static-welcome",
    "reply-with-presentation",
  ]);
  readonly inputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "audio",
    "video",
    "file",
  ]);
  readonly outputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "audio",
    "video",
    "file",
  ]);
  readonly deliveries: OutboundCommand[] = [];

  private readonly now: () => string;
  private onMessage?: (message: InboundMessage) => Promise<void>;
  private onFeedback?: (event: ChannelFeedbackEvent) => Promise<void>;
  private onEnterChat?: (event: ChannelEnterChatEvent) => Promise<boolean>;
  private running = false;
  private nextDelivery = 1;

  constructor(options: LoopbackTransportOptions = {}) {
    this.id = options.id ?? "loopback";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(
    onMessage: (message: InboundMessage) => Promise<void>,
    onFeedback?: (event: ChannelFeedbackEvent) => Promise<void>,
    onEnterChat?: (event: ChannelEnterChatEvent) => Promise<boolean>,
  ): Promise<void> {
    if (this.running) throw new Error("Loopback Transport is already started");
    this.onMessage = onMessage;
    this.onFeedback = onFeedback;
    this.onEnterChat = onEnterChat;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.onMessage = undefined;
    this.onFeedback = undefined;
    this.onEnterChat = undefined;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return {
      ok: this.running,
      detail: this.running
        ? "Loopback Transport is ready"
        : "Loopback Transport is stopped",
    };
  }

  async deliver(command: OutboundCommand): Promise<DeliveryReceipt> {
    this.assertRunning();
    this.deliveries.push(command);
    return {
      id: `loopback-delivery-${this.nextDelivery++}`,
      acceptedAt: this.now(),
    };
  }

  async materializeInbound(
    message: InboundMessage,
  ): Promise<MaterializedInboundMessage> {
    this.assertRunning();
    let released = false;
    return {
      message,
      release: async () => {
        if (released) return;
        released = true;
      },
    };
  }

  async emitMessage(message: InboundMessage): Promise<void> {
    this.assertRunning();
    if (!this.onMessage) throw new Error("Inbound callback is unavailable");
    await this.onMessage(message);
  }

  async emitFeedback(event: ChannelFeedbackEvent): Promise<void> {
    this.assertRunning();
    if (!this.onFeedback) throw new Error("Feedback callback is unavailable");
    await this.onFeedback(event);
  }

  async emitEnterChat(event: ChannelEnterChatEvent): Promise<boolean> {
    this.assertRunning();
    if (!this.onEnterChat) {
      throw new Error("Enter-chat callback is unavailable");
    }
    return this.onEnterChat(event);
  }

  private assertRunning(): void {
    if (!this.running) throw new Error("Loopback Transport is not started");
  }
}
