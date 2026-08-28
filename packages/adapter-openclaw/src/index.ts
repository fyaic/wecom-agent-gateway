import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { GatewayClient } from "@openclaw/gateway-client";
import {
  agentInputParts,
  RUNTIME_CONTRACT_VERSION,
  type AgentInteractionResumeRequest,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type MediaType,
  type MessagePart,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

type JsonRecord = Record<string, unknown>;

export interface OpenClawClientHandlers {
  onHello(): void;
  onEvent(event: { event: string; payload?: unknown }): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface OpenClawGatewayClient {
  start(): void;
  request<T = JsonRecord>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number | null },
  ): Promise<T>;
  stop(): void;
  stopAndWait?(options?: { timeoutMs?: number }): Promise<void>;
}

export interface OpenClawRuntimeAdapterOptions {
  url?: string;
  token?: string;
  password?: string;
  agentId?: string;
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
  connectTimeoutMs?: number;
  clientFactory?: (handlers: OpenClawClientHandlers) => OpenClawGatewayClient;
}

interface PendingRun {
  sessionKey: string;
  queue: AsyncEventQueue;
  text: string;
  lastSeq: number;
  timer: NodeJS.Timeout;
}

/**
 * Thin adapter over OpenClaw's public Gateway WebSocket protocol. OpenClaw
 * owns reasoning, tools, and transcripts; this adapter owns only translation
 * into the runtime-neutral Channel contract.
 */
export class OpenClawRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "openclaw";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId = "openclaw:gateway-ws-v4";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
    "cancel",
    "status-events",
    "multimodal-input",
    "interaction-resume",
    "reply-actions",
    "quoted-context",
  ]);
  readonly inputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "audio",
    "video",
    "file",
  ]);

  private readonly url: string;
  private readonly requestTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly clientFactory: (
    handlers: OpenClawClientHandlers,
  ) => OpenClawGatewayClient;
  private client?: OpenClawGatewayClient;
  private ready = false;
  private stopping = false;
  private startPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRun>();
  private readonly completedInteractionResumes = new Set<string>();

  constructor(private readonly options: OpenClawRuntimeAdapterOptions = {}) {
    this.url = options.url ?? "ws://127.0.0.1:18789";
    assertLoopbackGatewayUrl(this.url);
    if (!options.token && !options.password && !options.clientFactory) {
      throw new Error(
        "OpenClaw Gateway authentication requires OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD",
      );
    }
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      30_000,
      "requestTimeoutMs",
    );
    this.runTimeoutMs = positiveInteger(
      options.runTimeoutMs,
      5 * 60_000,
      "runTimeoutMs",
    );
    this.connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs,
      15_000,
      "connectTimeoutMs",
    );
    this.clientFactory =
      options.clientFactory ??
      ((handlers) =>
        new GatewayClient({
          url: this.url,
          token: options.token,
          password: options.password,
          clientName: "gateway-client",
          clientDisplayName: "WeCom Agent Gateway",
          clientVersion: "0.1.0",
          platform: process.platform,
          mode: "backend",
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          requestTimeoutMs: this.requestTimeoutMs,
          onHelloOk: () => handlers.onHello(),
          onEvent: (event) => handlers.onEvent(event),
          onClose: (_code, reason) => handlers.onClose(reason),
          onConnectError: (error) => handlers.onError(error),
        }));
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `OpenClaw Gateway did not become ready within ${this.connectTimeoutMs}ms`,
          ),
        );
      }, this.connectTimeoutMs);
      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      this.client = this.clientFactory({
        onHello: () => {
          this.ready = true;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        onEvent: (event) => this.handleGatewayEvent(event),
        onClose: (reason) => {
          this.ready = false;
          if (!this.stopping) {
            this.failPending(
              new Error(`OpenClaw Gateway connection closed: ${reason}`),
            );
          }
        },
        onError: failStart,
      });
      try {
        this.client.start();
      } catch (error) {
        failStart(asError(error));
      }
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    yield* this.runWithIdempotencyKey(request, randomUUID());
  }

  private async *runWithIdempotencyKey(
    request: AgentRunRequest,
    runId: string,
  ): AsyncIterable<AgentRunEvent> {
    try {
      await this.start();
    } catch (error) {
      yield { type: "failed", message: asError(error).message };
      return;
    }

    const sessionKey =
      request.sessionId ?? `wecom-agent-gateway:${randomUUID()}`;
    const baseline = await this.readLatestAssistantSnapshot(sessionKey);
    if (!request.sessionId) {
      yield { type: "session-started", sessionId: sessionKey };
    }
    yield { type: "status", phase: "accepted" };

    const queue = new AsyncEventQueue();
    const pending: PendingRun = {
      sessionKey,
      queue,
      text: "",
      lastSeq: -1,
      timer: setTimeout(() => {
        queue.fail(
          new Error(
            `OpenClaw run did not finish within ${this.runTimeoutMs}ms`,
          ),
        );
      }, this.runTimeoutMs),
    };
    this.pending.set(runId, pending);

    try {
      const response = await this.client!.request<{ runId?: string }>(
        "chat.send",
        {
          sessionKey,
          ...(this.options.agentId ? { agentId: this.options.agentId } : {}),
          message: textFromParts(agentInputParts(request.message)),
          attachments: await attachmentsFromParts(
            agentInputParts(request.message),
          ),
          deliver: false,
          idempotencyKey: runId,
        },
        { timeoutMs: this.requestTimeoutMs },
      );
      if (response.runId && response.runId !== runId) {
        this.pending.delete(runId);
        this.pending.set(response.runId, pending);
      }
      void this.reconcileRun(
        response.runId ?? runId,
        pending,
        baseline?.fingerprint,
      );
      for await (const event of queue) yield event;
    } catch (error) {
      yield { type: "failed", message: asError(error).message };
    } finally {
      clearTimeout(pending.timer);
      for (const [key, value] of this.pending) {
        if (value === pending) this.pending.delete(key);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const entries = [...this.pending.entries()].filter(
      ([, run]) => run.sessionKey === sessionId,
    );
    await Promise.all(
      entries.map(([runId]) =>
        this.client?.request(
          "chat.abort",
          {
            sessionKey: sessionId,
            ...(this.options.agentId ? { agentId: this.options.agentId } : {}),
            runId,
          },
          { timeoutMs: this.requestTimeoutMs },
        ),
      ),
    );
  }

  async *resumeInteraction(
    request: AgentInteractionResumeRequest,
  ): AsyncIterable<AgentRunEvent> {
    if (this.completedInteractionResumes.has(request.idempotencyKey)) return;
    if (
      request.interaction.kind !== "actions" ||
      request.interaction.resumeMode !== "new-turn" ||
      !request.message
    ) {
      throw new Error("OpenClaw only supports new-turn reply actions");
    }
    yield* this.runWithIdempotencyKey(
      {
        message: request.message,
        sessionId: request.sessionId,
      },
      request.idempotencyKey,
    );
    rememberBounded(
      this.completedInteractionResumes,
      request.idempotencyKey,
      1_000,
    );
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.ready) return { ok: false, detail: "gateway-disconnected" };
    try {
      await this.client!.request("health", undefined, {
        timeoutMs: this.requestTimeoutMs,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: asError(error).message };
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.failPending(new Error("OpenClaw adapter stopped"));
    if (this.client?.stopAndWait) {
      await this.client.stopAndWait({ timeoutMs: 2_000 });
    } else {
      this.client?.stop();
    }
    this.client = undefined;
  }

  private handleGatewayEvent(event: {
    event: string;
    payload?: unknown;
  }): void {
    if (event.event !== "chat" || !isRecord(event.payload)) return;
    const runId = stringValue(event.payload.runId);
    const state = stringValue(event.payload.state);
    const seq = numberValue(event.payload.seq);
    if (!runId || !state || seq === undefined) return;
    const pending = this.pending.get(runId);
    if (!pending || seq <= pending.lastSeq) return;
    pending.lastSeq = seq;

    if (state === "status") {
      pending.queue.push({
        type: "status",
        phase: "thinking",
        text: statusText(stringValue(event.payload.phase)),
      });
      return;
    }
    if (state === "delta") {
      const next = stringValue(event.payload.deltaText) ?? "";
      if (event.payload.replace === true) {
        const suffix = next.startsWith(pending.text)
          ? next.slice(pending.text.length)
          : "";
        pending.text = next;
        if (suffix) pending.queue.push({ type: "text-delta", text: suffix });
      } else if (next) {
        pending.text += next;
        pending.queue.push({ type: "text-delta", text: next });
      }
      return;
    }
    if (state === "final") {
      const finalText =
        extractMessageText(event.payload.message) || pending.text;
      completePendingRun(pending, finalText);
      return;
    }
    if (state === "error" || state === "aborted") {
      pending.queue.fail(
        new Error(
          stringValue(event.payload.errorMessage) ??
            (state === "aborted"
              ? "OpenClaw run was aborted"
              : "OpenClaw run failed"),
        ),
      );
    }
  }

  private failPending(error: Error): void {
    for (const run of new Set(this.pending.values())) run.queue.fail(error);
  }

  private async reconcileRun(
    runId: string,
    pending: PendingRun,
    baselineFingerprint?: string,
  ): Promise<void> {
    try {
      const wait = await this.client!.request<JsonRecord>(
        "agent.wait",
        { runId, timeoutMs: this.runTimeoutMs },
        { timeoutMs: this.runTimeoutMs + 2_000 },
      );
      if (pending.queue.isSettled) return;
      const status = stringValue(wait.status) ?? "ok";
      if (status !== "ok") {
        pending.queue.fail(
          new Error(
            stringValue(wait.error) ??
              `OpenClaw run reconciliation ended with status ${status}`,
          ),
        );
        return;
      }
      const latest = await this.readLatestAssistantSnapshot(pending.sessionKey);
      if (pending.queue.isSettled) return;
      if (!latest?.text || latest.fingerprint === baselineFingerprint) {
        pending.queue.fail(
          new Error("OpenClaw run finished without a new assistant message"),
        );
        return;
      }
      completePendingRun(pending, latest.text);
    } catch (error) {
      if (!pending.queue.isSettled) pending.queue.fail(asError(error));
    }
  }

  private async readLatestAssistantSnapshot(
    sessionKey: string,
  ): Promise<{ text: string; fingerprint: string } | undefined> {
    try {
      const history = await this.client!.request<{ messages?: unknown[] }>(
        "chat.history",
        {
          sessionKey,
          ...(this.options.agentId ? { agentId: this.options.agentId } : {}),
          limit: 50,
        },
        { timeoutMs: this.requestTimeoutMs },
      );
      return latestAssistantSnapshot(history.messages);
    } catch {
      return undefined;
    }
  }
}

function rememberBounded(
  values: Set<string>,
  value: string,
  limit: number,
): void {
  values.add(value);
  if (values.size <= limit) return;
  const oldest = values.values().next().value;
  if (oldest !== undefined) values.delete(oldest);
}

class AsyncEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly values: AgentRunEvent[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<AgentRunEvent>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private error?: Error;

  get isSettled(): boolean {
    return this.ended || this.error !== undefined;
  }

  push(event: AgentRunEvent): void {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.values.push(event);
  }

  end(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.error) throw this.error;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentRunEvent>>((resolve, reject) =>
          this.waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

function completePendingRun(pending: PendingRun, finalText: string): void {
  if (pending.queue.isSettled) return;
  if (!pending.text && finalText) {
    pending.queue.push({ type: "text-delta", text: finalText });
  } else if (finalText.startsWith(pending.text)) {
    const suffix = finalText.slice(pending.text.length);
    if (suffix) pending.queue.push({ type: "text-delta", text: suffix });
  }
  pending.text = finalText;
  pending.queue.push({ type: "message-completed", text: finalText });
  pending.queue.end();
}

function latestAssistantSnapshot(
  messages: unknown[] | undefined,
): { text: string; fingerprint: string } | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = extractMessageText(message);
    if (!text.trim()) continue;
    let fingerprint: string;
    try {
      fingerprint = JSON.stringify(message);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint };
  }
  return undefined;
}

async function attachmentsFromParts(parts: MessagePart[]) {
  const attachments: JsonRecord[] = [];
  for (const part of parts) {
    if (part.type === "text") continue;
    if (!part.path) {
      throw new Error(
        `OpenClaw adapter requires materialized local ${part.type} input`,
      );
    }
    const content = await readFile(part.path);
    attachments.push({
      type: part.type,
      mimeType: part.mimeType,
      fileName: part.name ?? basename(part.path),
      content: content.toString("base64"),
      sizeBytes: content.byteLength,
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

function textFromParts(parts: MessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function statusText(phase: string | undefined): string {
  switch (phase) {
    case "preparing_workspace":
      return "正在准备工作区";
    case "provisioning_environment":
      return "正在准备运行环境";
    case "preparing_context":
      return "正在准备上下文";
    case "starting_model":
      return "正在启动模型";
    default:
      return "正在思考";
  }
}

function assertLoopbackGatewayUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid OPENCLAW_GATEWAY_URL: ${value}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("OPENCLAW_GATEWAY_URL must use ws:// or wss://");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "OpenClaw adapter currently accepts only a loopback Gateway URL",
    );
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
