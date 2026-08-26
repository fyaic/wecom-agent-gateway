import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  RUNTIME_CONTRACT_VERSION,
  type AgentInteractionResumeRequest,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type MediaType,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

export interface AcpRuntimeAdapterOptions {
  id: string;
  executable: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onStderr?: (message: string) => void;
}

type RunQueueEntry =
  | { type: "update"; update: SessionUpdate }
  | { type: "stop"; stopReason: StopReason };

interface ActiveRun {
  queue: AsyncQueue<RunQueueEntry>;
  request: AgentRunRequest;
}

/**
 * Kernel-neutral ACP v1 client adapter. The configured executable is the only
 * Kernel-specific detail; ACP wire types never cross into channel-core.
 */
export class AcpRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id: string;
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId: string;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly inputModalities: ReadonlySet<MediaType>;

  private readonly mutableCapabilities = new Set<RuntimeCapability>([
    "streaming",
    "cancel",
    "approval",
    "status-events",
  ]);
  private readonly mutableInputModalities = new Set<MediaType>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly completedInteractionResumes = new Set<string>();
  private child?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientConnection;
  private initializeResult?: InitializeResponse;
  private processError?: Error;

  constructor(private readonly options: AcpRuntimeAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.id)) {
      throw new Error(`Invalid ACP adapter id: ${options.id}`);
    }
    if (!options.executable) throw new Error("ACP executable is required");
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1)
    ) {
      throw new Error("ACP requestTimeoutMs must be a positive integer");
    }
    this.id = options.id;
    this.sessionCompatibilityId = `${options.id}:acp-v1`;
    this.capabilities = this.mutableCapabilities;
    this.inputModalities = this.mutableInputModalities;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    this.processError = undefined;
    this.mutableCapabilities.delete("multimodal-input");
    this.mutableCapabilities.delete("interaction-resume");
    this.mutableCapabilities.delete("reply-actions");
    this.mutableInputModalities.clear();
    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: resolve(this.options.cwd),
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.once("error", (error) => {
      this.processError = error;
      this.failActiveRuns(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const error = new Error(
        `ACP agent exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      );
      this.processError = error;
      this.connection = undefined;
      this.initializeResult = undefined;
      this.failActiveRuns(error);
    });
    this.forwardStderr(child);

    const app = acp
      .client({ name: "wecom-agent-gateway" })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        this.handlePermissionRequest(context.params),
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        this.activeRuns.get(context.params.sessionId)?.queue.push({
          type: "update",
          update: context.params.update,
        });
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;

    try {
      const initialized = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "WeCom Agent Gateway",
            version: "0.1.0",
          },
        },
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version: ${initialized.protocolVersion}`,
        );
      }
      this.initializeResult = initialized;
      if (initialized.agentCapabilities?.loadSession) {
        this.mutableCapabilities.add("resume");
        this.mutableCapabilities.add("interaction-resume");
        this.mutableCapabilities.add("reply-actions");
      }
      const prompts = initialized.agentCapabilities?.promptCapabilities;
      if (prompts?.image) this.mutableInputModalities.add("image");
      if (prompts?.audio) this.mutableInputModalities.add("audio");
      if (this.mutableInputModalities.size > 0) {
        this.mutableCapabilities.add("multimodal-input");
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    const child = this.child;
    this.connection = undefined;
    this.initializeResult = undefined;
    this.child = undefined;
    connection?.close();
    this.failActiveRuns(new Error("ACP adapter stopped"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      ),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const connection = this.connection;
    const initialized = this.initializeResult;
    if (!connection || !initialized)
      throw new Error("ACP adapter is not started");

    let sessionId = request.sessionId;
    if (sessionId) {
      if (!initialized.agentCapabilities?.loadSession) {
        throw new Error(`ACP agent ${this.id} cannot resume sessions`);
      }
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: resolve(this.options.cwd),
        mcpServers: [],
      });
    } else {
      const created = await connection.agent.request(
        acp.methods.agent.session.new,
        {
          cwd: resolve(this.options.cwd),
          mcpServers: [],
        },
      );
      sessionId = created.sessionId;
      yield { type: "session-started", sessionId };
    }

    const queue = new AsyncQueue<RunQueueEntry>();
    this.activeRuns.set(sessionId, { queue, request });
    let finalText = "";
    const timeout = setTimeout(
      () => {
        void connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId,
        });
        queue.fail(new Error("ACP prompt timed out"));
      },
      this.options.requestTimeoutMs ?? 5 * 60_000,
    );
    try {
      const prompt = await this.toPrompt(request);
      void connection.agent
        .request(acp.methods.agent.session.prompt, { sessionId, prompt })
        .then((response) =>
          queue.push({ type: "stop", stopReason: response.stopReason }),
        )
        .catch((error: unknown) => queue.fail(asError(error)));

      for (;;) {
        const entry = await queue.shift();
        if (entry.type === "stop") {
          if (entry.stopReason === "cancelled") {
            yield { type: "failed", message: "Agent run cancelled" };
          } else if (entry.stopReason === "refusal") {
            yield { type: "failed", message: "Agent declined the request" };
          } else {
            yield {
              type: "message-completed",
              text: finalText || undefined,
            };
          }
          return;
        }

        const event = mapSessionUpdate(entry.update);
        if (!event) continue;
        if (event.type === "text-delta") finalText += event.text;
        yield event;
      }
    } catch (error) {
      yield { type: "failed", message: safeErrorMessage(error) };
    } finally {
      clearTimeout(timeout);
      this.activeRuns.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
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
      throw new Error(
        `ACP agent ${this.id} only supports new-turn reply actions`,
      );
    }
    yield* this.run({
      message: request.message,
      sessionId: request.sessionId,
    });
    rememberBounded(
      this.completedInteractionResumes,
      request.idempotencyKey,
      1_000,
    );
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (this.processError)
      return { ok: false, detail: this.processError.message };
    if (!this.connection || !this.initializeResult || !this.child) {
      return { ok: false, detail: "ACP agent is not started" };
    }
    return {
      ok: true,
      detail: `${this.initializeResult.agentInfo?.name ?? this.id} connected over ACP v${this.initializeResult.protocolVersion}`,
    };
  }

  private async toPrompt(request: AgentRunRequest): Promise<ContentBlock[]> {
    const prompts =
      this.initializeResult?.agentCapabilities?.promptCapabilities;
    const blocks: ContentBlock[] = [];
    for (const part of request.message.parts) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image" && prompts?.image && part.path) {
        blocks.push({
          type: "image",
          data: (await readFile(part.path)).toString("base64"),
          mimeType: part.mimeType ?? "application/octet-stream",
        });
      } else if (part.type === "audio" && prompts?.audio && part.path) {
        blocks.push({
          type: "audio",
          data: (await readFile(part.path)).toString("base64"),
          mimeType: part.mimeType ?? "application/octet-stream",
        });
      } else {
        throw new Error(
          `ACP agent ${this.id} cannot accept ${part.type} input`,
        );
      }
    }
    if (blocks.length === 0)
      throw new Error("ACP prompt has no supported content");
    return blocks;
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const active = this.activeRuns.get(params.sessionId);
    const reject = params.options.find(
      (option) =>
        option.kind === "reject_once" || option.kind === "reject_always",
    );
    if (!active?.request.requestApproval) {
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const title = bounded(params.toolCall.title ?? "ACP agent tool", 240);
    const toolName = stableToolName(params.toolCall.name ?? "acp_agent_tool");
    const decision = await active.request.requestApproval({
      toolName,
      effect: "write",
      summary: title,
    });
    if (decision === "approved") {
      // One Gateway approval authorizes exactly this tool call. Never translate
      // it into ACP's broader allow-always outcome.
      const allow = params.options.find(
        (option) => option.kind === "allow_once",
      );
      if (allow) {
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
    }
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private forwardStderr(child: ChildProcessWithoutNullStreams): void {
    if (!this.options.onStderr) return;
    let pending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) this.options.onStderr?.(line);
    });
    child.stderr.once("end", () => {
      if (pending) this.options.onStderr?.(pending);
    });
  }

  private failActiveRuns(error: Error): void {
    for (const active of this.activeRuns.values()) active.queue.fail(error);
    this.activeRuns.clear();
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

function mapSessionUpdate(update: SessionUpdate): AgentRunEvent | undefined {
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    update.content.text
  ) {
    return { type: "text-delta", text: update.content.text };
  }
  if (update.sessionUpdate === "tool_call") {
    return {
      type: "status",
      phase: "tool-running",
      text: bounded(update.title, 160),
    };
  }
  if (
    update.sessionUpdate === "tool_call_update" &&
    update.title &&
    update.status === "in_progress"
  ) {
    return {
      type: "status",
      phase: "tool-running",
      text: bounded(update.title, 160),
    };
  }
  return undefined;
}

function stableToolName(value: string): string {
  const normalized = value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
  return normalized || "acp_agent_tool";
}

function bounded(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeErrorMessage(error: unknown): string {
  const message = asError(error).message;
  if (/auth|login|credential/i.test(message))
    return "Agent authentication required";
  if (
    /not started|cannot resume|cannot accept|no supported content/i.test(
      message,
    )
  ) {
    return message;
  }
  return "Agent runtime failed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure?: Error;

  push(value: T): void {
    if (this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async shift(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.failure) throw this.failure;
    return new Promise<T>((resolveValue, reject) => {
      this.waiters.push({ resolve: resolveValue, reject });
    });
  }
}
