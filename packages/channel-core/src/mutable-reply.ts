import type {
  AgentRunEvent,
  AgentStatusPhase,
  Presentation,
} from "@fyaic/wecom-runtime-contract";

export interface ReplyUpdate {
  text: string;
  final: boolean;
  presentation?: Presentation;
}

export interface MutableReplyOptions {
  updateIntervalMs?: number;
  initialText?: string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Owns presentation timing only. It never alters user input, Agent prompts,
 * routing, model choices, or tool decisions.
 */
export class MutableReply {
  private readonly intervalMs: number;
  private readonly initialText: string;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown;
  private pendingText: string | undefined;
  private inFlight = Promise.resolve();
  private closed = false;

  constructor(
    private readonly deliver: (update: ReplyUpdate) => Promise<void>,
    options: MutableReplyOptions = {},
  ) {
    this.intervalMs = options.updateIntervalMs ?? 250;
    this.initialText = options.initialText ?? "⏳ 已收到，等待 Agent 响应…";
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  async open(): Promise<void> {
    await this.deliver({ text: this.initialText, final: false });
  }

  update(text: string): void {
    if (this.closed) return;
    this.pendingText = text;
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => this.flushPending(), this.intervalMs);
    }
  }

  async close(text: string, presentation?: Presentation): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingText = undefined;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
    await this.deliver({
      text,
      final: true,
      ...(presentation ? { presentation } : {}),
    });
  }

  private flushPending(): void {
    this.timer = undefined;
    const text = this.pendingText;
    this.pendingText = undefined;
    if (text === undefined || this.closed) return;
    this.inFlight = this.inFlight.then(() =>
      this.deliver({ text, final: false }),
    );
    if (this.pendingText !== undefined && this.timer === undefined) {
      this.timer = this.setTimer(() => this.flushPending(), this.intervalMs);
    }
  }
}

export class AgentReplyProjection {
  private text = "";
  private status = "";

  apply(event: AgentRunEvent): string | undefined {
    if (event.type === "status") {
      this.status = renderAgentStatus(event);
      return this.current() || undefined;
    }
    if (event.type === "text-delta") {
      this.text += event.text;
      this.status = "";
      return this.current() || undefined;
    }
    return undefined;
  }

  completed(explicitText?: string): string {
    return explicitText ?? this.text;
  }

  private current(): string {
    if (!this.text) return this.status;
    return this.status ? `${this.text}\n\n${this.status}` : this.text;
  }
}

function renderAgentStatus(event: Extract<AgentRunEvent, { type: "status" }>) {
  const emoji = event.emoji ?? defaultStatusEmoji(event.phase);
  const text = event.text ?? defaultStatusText(event.phase);
  return [emoji, text].filter(Boolean).join(" ");
}

function defaultStatusEmoji(phase: AgentStatusPhase): string {
  switch (phase) {
    case "accepted":
      return "✅";
    case "queued":
      return "⏳";
    case "thinking":
      return "🤔";
    case "tool-running":
      return "🛠️";
    case "waiting-approval":
      return "⏸️";
    case "custom":
      return "";
  }
}

function defaultStatusText(phase: AgentStatusPhase): string {
  switch (phase) {
    case "accepted":
      return "Agent 已接收";
    case "queued":
      return "Agent 排队中…";
    case "thinking":
      return "Agent 正在思考…";
    case "tool-running":
      return "Agent 正在使用工具…";
    case "waiting-approval":
      return "等待人工审批";
    case "custom":
      return "";
  }
}
