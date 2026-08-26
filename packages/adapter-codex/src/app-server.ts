import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  RUNTIME_CONTRACT_VERSION,
  type AgentInteractionResumeRequest,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type MediaType,
  type MessagePart,
  type RuntimeCapability,
  type RuntimeInteractionRequest,
  type RuntimeJsonValue,
  type RuntimeTool,
  type RuntimeToolResult,
} from "@fyaic/wecom-runtime-contract";

type JsonObject = Record<string, unknown>;

export interface CodexAppServerThreadOptions {
  cwd?: string;
  model?: string;
  serviceTier?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  dynamicTools?: CodexDynamicToolSpec[];
}

export interface CodexDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: RuntimeJsonValue;
}

export interface CodexDynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: RuntimeJsonValue;
}

export interface CodexDynamicToolCallResult {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
}

export interface RuntimeToolLifecycleEvent {
  toolName: string;
  effect: RuntimeTool["effect"];
  phase: "started" | "succeeded" | "failed";
  elapsedMs: number;
}

export interface CodexAppServerTurnOptions {
  cwd?: string;
  model?: string;
  serviceTier?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export type CodexAppServerInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string };

export interface CodexAppServerEvent {
  method: string;
  params: JsonObject;
  /** Present only for server-initiated JSON-RPC requests. */
  requestId?: number | string;
}

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

export interface CodexUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export interface CodexAppServerClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): { ok: boolean; detail?: string };
  startThread(options: CodexAppServerThreadOptions): Promise<string>;
  resumeThread(
    threadId: string,
    options: CodexAppServerThreadOptions,
  ): Promise<void>;
  runTurn(
    threadId: string,
    input: CodexAppServerInput[],
    options: CodexAppServerTurnOptions,
  ): Promise<AsyncIterable<CodexAppServerEvent>>;
  respondToUserInput(
    requestId: number | string,
    response: CodexUserInputResponse,
  ): Promise<void>;
  interrupt(threadId: string): Promise<void>;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ActiveTurn {
  turnId?: string;
  queue: AsyncEventQueue<CodexAppServerEvent>;
}

export interface CodexAppServerClientOptions {
  executable?: string;
  cwd?: string;
  codexHome?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  responsesWebsocket?: boolean;
  processFactory?: (spec: {
    executable: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => ChildProcessWithoutNullStreams;
  onStderr?: (line: string) => void;
  dynamicToolHandler?: (
    call: CodexDynamicToolCall,
  ) => Promise<CodexDynamicToolCallResult>;
  onDynamicToolError?: (error: Error) => void;
}

/** A narrow JSONL client for the stable Codex app-server methods we consume. */
export class CodexAppServerClient implements CodexAppServerClientLike {
  private process?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingUserInputs = new Map<
    number | string,
    { threadId: string; turnId: string }
  >();
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private initialized = false;
  private stopping = false;
  private readonly stderrTail: string[] = [];

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.process) throw new Error("Codex app-server is already starting");
    const executable = this.options.executable ?? "codex";
    const args = ["app-server", "--stdio"];
    if (this.options.responsesWebsocket !== true) {
      args.push(...httpOnlyProviderArgs());
    }
    const env = {
      ...process.env,
      ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}),
    };
    const child = this.options.processFactory
      ? this.options.processFactory({
          executable,
          args,
          cwd: this.options.cwd,
          env,
        })
      : spawn(executable, args, {
          cwd: this.options.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.process = child;
    this.stopping = false;
    this.stderrTail.length = 0;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.once("error", (error) => {
      if (this.process === child) this.handleExit(error);
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const detail = this.stderrTail.at(-1);
      this.handleExit(
        this.stopping
          ? undefined
          : new Error(
              `Codex app-server exited (code=${String(code)}, signal=${String(signal)})${detail ? `: ${redactDiagnostic(detail)}` : ""}`,
            ),
      );
    });
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.handleLine(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 8) this.stderrTail.shift();
      this.options.onStderr?.(line);
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "fyaic_wecom_agent_gateway",
          title: "FYAIC WeCom Agent Gateway",
          version: this.options.clientVersion ?? "0.1.0",
        },
        capabilities: {
          // item/tool/requestUserInput is currently experimental. Opt in
          // explicitly because the Adapter handles it as a native control
          // response, never as a fabricated semantic turn.
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    this.initialized = false;
    child.stdin.end();
    const exited = await waitFor(this.exitPromise ?? Promise.resolve(), 2_000);
    if (!exited) {
      child.kill("SIGTERM");
      const terminated = await waitFor(
        this.exitPromise ?? Promise.resolve(),
        2_000,
      );
      if (!terminated) child.kill("SIGKILL");
    }
  }

  health(): { ok: boolean; detail?: string } {
    return this.initialized && this.process
      ? { ok: true }
      : { ok: false, detail: "Codex app-server is not initialized" };
  }

  async startThread(options: CodexAppServerThreadOptions): Promise<string> {
    const result = asRecord(
      await this.request("thread/start", asRecord(compact(options))),
    );
    const threadId = stringValue(asRecord(result.thread).id);
    if (!threadId) throw new Error("Codex thread/start returned no thread id");
    return threadId;
  }

  async resumeThread(
    threadId: string,
    options: CodexAppServerThreadOptions,
  ): Promise<void> {
    const { dynamicTools: _persistedDynamicTools, ...resumeOptions } = options;
    await this.request("thread/resume", {
      threadId,
      ...compact(resumeOptions),
    });
  }

  async runTurn(
    threadId: string,
    input: CodexAppServerInput[],
    options: CodexAppServerTurnOptions,
  ): Promise<AsyncIterable<CodexAppServerEvent>> {
    if (this.activeTurns.has(threadId)) {
      throw new Error(`Codex thread already has an active turn: ${threadId}`);
    }
    const active: ActiveTurn = { queue: new AsyncEventQueue() };
    this.activeTurns.set(threadId, active);
    try {
      const result = asRecord(
        await this.request("turn/start", {
          threadId,
          input,
          ...compact(options),
        }),
      );
      const turnId = stringValue(asRecord(result.turn).id);
      if (!turnId) throw new Error("Codex turn/start returned no turn id");
      active.turnId = turnId;
      return active.queue;
    } catch (error) {
      this.activeTurns.delete(threadId);
      active.queue.fail(asError(error));
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const active = this.activeTurns.get(threadId);
    if (!active?.turnId) return;
    await this.request("turn/interrupt", {
      threadId,
      turnId: active.turnId,
    });
  }

  async respondToUserInput(
    requestId: number | string,
    response: CodexUserInputResponse,
  ): Promise<void> {
    if (!this.pendingUserInputs.has(requestId)) {
      throw new Error("Codex user-input request is no longer pending");
    }
    this.write({ id: requestId, result: response });
    this.pendingUserInputs.delete(requestId);
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    const child = this.process;
    if (!child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      this.failAll(new Error("Codex app-server emitted invalid JSON"));
      return;
    }
    const id = requestId(message.id);
    if (id !== undefined && ("result" in message || "error" in message)) {
      this.handleResponse(message as unknown as RpcResponse);
      return;
    }
    const method = stringValue(message.method);
    if (!method) return;
    if (id !== undefined) {
      this.handleServerRequest(id, method, asRecord(message.params));
      return;
    }
    const params = asRecord(message.params);
    if (method === "serverRequest/resolved") {
      const resolvedId = requestId(params.requestId);
      if (resolvedId !== undefined) this.pendingUserInputs.delete(resolvedId);
    }
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    const active = this.activeTurns.get(threadId);
    if (!active) return;
    const turnId =
      stringValue(params.turnId) ?? stringValue(asRecord(params.turn).id);
    if (active.turnId && turnId && active.turnId !== turnId) return;
    const event = { method, params };
    active.queue.push(event);
    if (method === "turn/completed") {
      active.queue.close();
      this.activeTurns.delete(threadId);
    }
  }

  private handleResponse(message: RpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          `Codex app-server error${message.error.code === undefined ? "" : ` ${message.error.code}`}: ${message.error.message ?? "unknown error"}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    params: JsonObject,
  ): void {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.write({ id, result: { decision: "decline" } });
      return;
    }
    if (method === "item/tool/call") {
      void this.handleDynamicToolCall(id, params);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const request = parseCodexUserInputRequest(params);
      const active = request
        ? this.activeTurns.get(request.threadId)
        : undefined;
      if (
        !request ||
        !active ||
        (active.turnId !== undefined && active.turnId !== request.turnId) ||
        this.pendingUserInputs.has(id)
      ) {
        this.write({ id, result: { answers: {} } });
        return;
      }
      this.pendingUserInputs.set(id, {
        threadId: request.threadId,
        turnId: request.turnId,
      });
      active.queue.push({ method, params, requestId: id });
      return;
    }
    this.write({
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    });
  }

  private async handleDynamicToolCall(
    id: number | string,
    params: JsonObject,
  ): Promise<void> {
    try {
      const handler = this.options.dynamicToolHandler;
      if (!handler) throw new Error("No dynamic tool handler is configured");
      const call = parseDynamicToolCall(params);
      this.write({ id, result: await handler(call) });
    } catch (error) {
      this.options.onDynamicToolError?.(asError(error));
      this.write({
        id,
        result: {
          success: false,
          contentItems: [{ type: "inputText", text: "Tool execution failed." }],
        },
      });
    }
  }

  private handleExit(error?: Error): void {
    this.process = undefined;
    this.initialized = false;
    if (error) this.failAll(error);
    else this.failAll(new Error("Codex app-server stopped"));
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.stopping = false;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.pendingUserInputs.clear();
    for (const active of this.activeTurns.values()) active.queue.fail(error);
    this.activeTurns.clear();
  }
}

export interface CodexAppServerRuntimeAdapterOptions
  extends CodexAppServerThreadOptions, CodexAppServerTurnOptions {
  client?: CodexAppServerClientLike;
  executable?: string;
  codexHome?: string;
  requestTimeoutMs?: number;
  responsesWebsocket?: boolean;
  onStderr?: (line: string) => void;
  tools?: readonly RuntimeTool[];
  toolTimeoutMs?: number;
  approvalWaitTimeoutMs?: number;
  maxToolOutputBytes?: number;
  onToolError?: (error: Error) => void;
  onToolLifecycle?: (event: RuntimeToolLifecycleEvent) => void;
}

interface PendingCodexUserInput {
  requestId: number | string;
  questions: CodexUserInputQuestion[];
  answers: Record<string, { answers: string[] }>;
  currentQuestion: number;
  request: RuntimeInteractionRequest;
  mode: "single" | "form" | "sequential";
  expiresInMs?: number;
}

export class CodexAppServerRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "codex-app-server";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId: string;
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
    "cancel",
    "approval",
    "status-events",
    "tools",
    "multimodal-input",
    "interaction-resume",
    "interaction-live-resume",
    "reply-actions",
  ]);
  readonly inputModalities: ReadonlySet<MediaType> = new Set([
    "image",
    "audio",
  ]);
  private readonly client: CodexAppServerClientLike;
  private readonly loadedThreads = new Set<string>();
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly activeRequests = new Map<string, AgentRunRequest>();
  private readonly completedInteractionResumes = new Set<string>();
  private readonly pendingUserInputs = new Map<string, PendingCodexUserInput>();

  constructor(
    private readonly options: CodexAppServerRuntimeAdapterOptions = {},
  ) {
    for (const tool of options.tools ?? []) {
      validateRuntimeTool(tool, this.tools);
      this.tools.set(tool.name, tool);
    }
    this.sessionCompatibilityId = runtimeSessionCompatibilityId(this.tools);
    this.client =
      options.client ??
      new CodexAppServerClient({
        executable: options.executable,
        cwd: options.cwd,
        codexHome: options.codexHome,
        requestTimeoutMs: options.requestTimeoutMs,
        responsesWebsocket: options.responsesWebsocket,
        onStderr: options.onStderr,
        dynamicToolHandler:
          this.tools.size > 0
            ? (call) => this.executeDynamicTool(call)
            : undefined,
        onDynamicToolError: options.onToolError,
      });
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
    this.loadedThreads.clear();
    this.pendingUserInputs.clear();
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    if (!this.client.health().ok) await this.client.start();
    const threadOptions = this.threadOptions();
    let threadId = request.sessionId;
    if (!threadId) {
      threadId = await this.client.startThread(threadOptions);
      this.loadedThreads.add(threadId);
      yield { type: "session-started", sessionId: threadId };
    } else if (!this.loadedThreads.has(threadId)) {
      await this.client.resumeThread(threadId, threadOptions);
      this.loadedThreads.add(threadId);
    }

    this.activeRequests.set(threadId, request);
    try {
      const events = await this.client.runTurn(
        threadId,
        toCodexInput(request.message.parts),
        this.turnOptions(),
      );
      let finalText = "";
      for await (const event of events) {
        if (event.method === "item/agentMessage/delta") {
          const delta = stringValue(event.params.delta);
          if (delta) yield { type: "text-delta", text: delta };
        } else if (event.method === "item/tool/requestUserInput") {
          const pending = codexUserInputInteraction(event);
          if (!pending || this.pendingUserInputs.has(threadId)) {
            if (event.requestId !== undefined) {
              await this.client.respondToUserInput(event.requestId, {
                answers: {},
              });
            }
            continue;
          }
          this.pendingUserInputs.set(threadId, pending);
          yield { type: "interaction-requested", request: pending.request };
        } else if (event.method === "item/started") {
          const item = asRecord(event.params.item);
          const itemType = stringValue(item.type);
          if (itemType === "reasoning") {
            yield { type: "status", phase: "thinking" };
          } else if (
            itemType === "commandExecution" ||
            itemType === "mcpToolCall" ||
            itemType === "dynamicToolCall"
          ) {
            yield { type: "status", phase: "tool-running" };
          }
        } else if (event.method === "item/completed") {
          const item = asRecord(event.params.item);
          if (stringValue(item.type) === "agentMessage") {
            finalText = stringValue(item.text) ?? finalText;
          }
        } else if (event.method === "error") {
          if (event.params.willRetry !== true) {
            yield {
              type: "failed",
              message:
                stringValue(asRecord(event.params.error).message) ??
                "Codex turn failed",
            };
          }
        } else if (event.method === "turn/completed") {
          const turn = asRecord(event.params.turn);
          const status = stringValue(turn.status);
          if (status === "completed") {
            yield {
              type: "message-completed",
              text: finalText || undefined,
            };
          } else {
            yield {
              type: "failed",
              message:
                stringValue(asRecord(turn.error).message) ??
                `Codex turn ${status ?? "failed"}`,
            };
          }
        }
      }
    } finally {
      if (this.activeRequests.get(threadId) === request) {
        this.activeRequests.delete(threadId);
      }
      this.pendingUserInputs.delete(threadId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.client.interrupt(sessionId);
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
      const pending = this.pendingUserInputs.get(request.sessionId);
      if (!pending) {
        throw new Error("Codex user-input request is no longer live");
      }
      const next = applyCodexUserInputResult(pending, request);
      rememberBounded(
        this.completedInteractionResumes,
        request.idempotencyKey,
        1_000,
      );
      if (next) {
        pending.request = next;
        yield { type: "interaction-requested", request: next };
        return;
      }
      await this.client.respondToUserInput(pending.requestId, {
        answers: pending.answers,
      });
      this.pendingUserInputs.delete(request.sessionId);
      return;
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
    return this.client.health();
  }

  private threadOptions(): CodexAppServerThreadOptions {
    return compact({
      cwd: this.options.cwd,
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandbox ?? "read-only",
      dynamicTools:
        this.tools.size > 0
          ? [...this.tools.values()].map(toCodexDynamicToolSpec)
          : undefined,
    });
  }

  private turnOptions(): CodexAppServerTurnOptions {
    return compact({
      cwd: this.options.cwd,
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      effort: this.options.effort,
    });
  }

  private async executeDynamicTool(
    call: CodexDynamicToolCall,
  ): Promise<CodexDynamicToolCallResult> {
    if (call.namespace !== null) {
      throw new Error("Namespaced dynamic tools are not supported");
    }
    const tool = this.tools.get(call.tool);
    if (!tool) throw new Error("Unknown dynamic tool");
    if (tool.approval === "required") {
      const request = this.activeRequests.get(call.threadId);
      if (!request?.requestApproval) {
        throw new Error("Runtime approval handler is unavailable");
      }
      const summary =
        tool.approvalSummary?.(call.arguments) ?? tool.description;
      validateApprovalSummary(summary);
      const decision = await request.requestApproval({
        toolName: tool.name,
        effect: tool.effect as "write" | "destructive",
        summary,
        maxWaitMs: this.options.approvalWaitTimeoutMs ?? 90_000,
      });
      if (decision !== "approved") {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Tool execution was ${decision}.`,
            },
          ],
        };
      }
    }
    const startedAt = Date.now();
    this.notifyToolLifecycle(tool, "started", 0);
    try {
      const result = await withTimeout(
        tool.execute(call.arguments, {
          sessionId: call.threadId,
          callId: call.callId,
        }),
        this.options.toolTimeoutMs ?? 60_000,
      );
      validateToolResult(result, this.options.maxToolOutputBytes ?? 256 * 1024);
      this.notifyToolLifecycle(tool, "succeeded", Date.now() - startedAt);
      return {
        success: result.success,
        contentItems: result.content.map((item) => {
          if (item.type === "text") {
            return { type: "inputText" as const, text: item.text };
          }
          if (item.type === "image") {
            return { type: "inputImage" as const, imageUrl: item.url };
          }
          return { type: "inputAudio" as const, audioUrl: item.url };
        }),
      };
    } catch (error) {
      this.notifyToolLifecycle(tool, "failed", Date.now() - startedAt);
      throw error;
    }
  }

  private notifyToolLifecycle(
    tool: RuntimeTool,
    phase: RuntimeToolLifecycleEvent["phase"],
    elapsedMs: number,
  ): void {
    this.options.onToolLifecycle?.({
      toolName: tool.name,
      effect: tool.effect,
      phase,
      elapsedMs,
    });
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

function toCodexInput(parts: MessagePart[]): CodexAppServerInput[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text, text_elements: [] };
    }
    if (part.type === "image") {
      if (part.path) return { type: "localImage", path: part.path };
      if (part.url) return { type: "image", url: part.url };
    }
    if (part.type === "audio") {
      if (part.path) return { type: "localAudio", path: part.path };
      if (part.url) return { type: "audio", url: part.url };
    }
    throw new Error(
      `Codex app-server adapter cannot consume ${part.type} before Channel media materialization`,
    );
  });
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.failure) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestId(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string"
    ? value
    : undefined;
}

function parseCodexUserInputRequest(params: JsonObject):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: CodexUserInputQuestion[];
      autoResolutionMs: number | null;
    }
  | undefined {
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const itemId = stringValue(params.itemId);
  const autoResolutionMs = params.autoResolutionMs;
  if (
    !threadId ||
    !turnId ||
    !itemId ||
    (autoResolutionMs !== null &&
      (!Number.isInteger(autoResolutionMs) ||
        typeof autoResolutionMs !== "number" ||
        autoResolutionMs < 1)) ||
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    return undefined;
  }
  const questions: CodexUserInputQuestion[] = [];
  const ids = new Set<string>();
  for (const value of params.questions) {
    const question = asRecord(value);
    const id = boundedProtocolText(question.id, 256);
    const header = boundedProtocolText(question.header, 100);
    const prompt = boundedProtocolText(question.question, 2_000);
    if (
      !id ||
      !header ||
      !prompt ||
      ids.has(id) ||
      typeof question.isOther !== "boolean" ||
      typeof question.isSecret !== "boolean"
    ) {
      return undefined;
    }
    ids.add(id);
    let options: CodexUserInputOption[] | null = null;
    if (question.options !== null) {
      if (
        !Array.isArray(question.options) ||
        question.options.length < 1 ||
        question.options.length > 10
      ) {
        return undefined;
      }
      options = [];
      const labels = new Set<string>();
      for (const rawOption of question.options) {
        const option = asRecord(rawOption);
        const label = boundedProtocolText(option.label, 100);
        const description =
          typeof option.description === "string" &&
          [...option.description].length <= 500 &&
          !/[\0]/.test(option.description)
            ? option.description.trim()
            : undefined;
        if (!label || description === undefined || labels.has(label)) {
          return undefined;
        }
        labels.add(label);
        options.push({ label, description });
      }
    }
    questions.push({
      id,
      header,
      question: prompt,
      isOther: question.isOther,
      isSecret: question.isSecret,
      options,
    });
  }
  return {
    threadId,
    turnId,
    itemId,
    questions,
    autoResolutionMs,
  };
}

function codexUserInputInteraction(
  event: CodexAppServerEvent,
): PendingCodexUserInput | undefined {
  if (event.requestId === undefined) return undefined;
  const parsed = parseCodexUserInputRequest(event.params);
  if (!parsed || parsed.questions.some((question) => question.isSecret)) {
    return undefined;
  }
  const expiresInMs = parsed.autoResolutionMs ?? undefined;
  const allCardChoices = parsed.questions.every(
    (question) => question.options && !question.isOther,
  );
  const formFitsWeCom =
    parsed.questions.length > 1 &&
    allCardChoices &&
    parsed.questions.every(
      (question) =>
        [...question.header].length <= 13 &&
        question.options!.every((option) => [...option.label].length <= 10),
    );
  const mode =
    allCardChoices && parsed.questions.length === 1
      ? "single"
      : formFitsWeCom
        ? "form"
        : "sequential";
  return {
    requestId: event.requestId,
    questions: parsed.questions,
    answers: {},
    currentQuestion: 0,
    request:
      mode === "form"
        ? codexChoiceForm(parsed.questions, expiresInMs)
        : codexQuestionInteraction(parsed.questions[0]!, 0, expiresInMs),
    mode,
    expiresInMs,
  };
}

function codexChoiceForm(
  questions: CodexUserInputQuestion[],
  expiresInMs?: number,
): RuntimeInteractionRequest {
  return {
    kind: "form",
    title: "Codex 需要补充信息",
    description: fitRuntimeText(
      questions
        .map((question, index) => `${index + 1}. ${question.question}`)
        .join("\n"),
      2_000,
    ),
    fields: questions.map((question, questionIndex) => ({
      id: `question_${questionIndex}`,
      label: question.header,
      options: question.options!.map((option, optionIndex) => ({
        value: `option_${questionIndex}_${optionIndex}`,
        label: option.label,
      })),
    })),
    ...(expiresInMs === undefined ? {} : { expiresInMs }),
  };
}

function codexQuestionInteraction(
  question: CodexUserInputQuestion,
  questionIndex: number,
  expiresInMs?: number,
): RuntimeInteractionRequest {
  const fieldId = `question_${questionIndex}`;
  if (question.options && !question.isOther) {
    const optionDetails = question.options
      .filter((option) => option.description)
      .map((option) => `${option.label}：${option.description}`)
      .join("\n");
    return {
      kind: "single-select",
      title: question.header,
      description: fitRuntimeText(
        [question.question, optionDetails].filter(Boolean).join("\n"),
        2_000,
      ),
      fieldId,
      options: question.options.map((option, optionIndex) => ({
        value: `option_${questionIndex}_${optionIndex}`,
        label: option.label,
      })),
      ...(expiresInMs === undefined ? {} : { expiresInMs }),
    };
  }
  const choices = question.options?.map((option) => option.label).join("、");
  return {
    kind: "text-input",
    title: question.header,
    description: fitRuntimeText(
      [
        question.question,
        choices
          ? `可选：${choices}${question.isOther ? "；也可以输入其他答案。" : ""}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      2_000,
    ),
    fieldId,
    ...(expiresInMs === undefined ? {} : { expiresInMs }),
  };
}

function applyCodexUserInputResult(
  pending: PendingCodexUserInput,
  resume: AgentInteractionResumeRequest,
): RuntimeInteractionRequest | undefined {
  if (resume.interaction.kind !== pending.request.kind) {
    throw new Error(
      "Codex user-input interaction does not match pending state",
    );
  }
  if (resume.result.status !== "submitted") {
    pending.answers = {};
    return undefined;
  }
  if (pending.mode === "form") {
    for (const [questionIndex, question] of pending.questions.entries()) {
      pending.answers[question.id] = {
        answers: [
          selectedCodexOption(
            question,
            questionIndex,
            resume.result.values[`question_${questionIndex}`]?.[0],
          ),
        ],
      };
    }
    return undefined;
  }
  const questionIndex = pending.currentQuestion;
  const question = pending.questions[questionIndex]!;
  const selected = resume.result.values[`question_${questionIndex}`]?.[0];
  if (selected === undefined) {
    throw new Error("Codex user-input answer is missing");
  }
  pending.answers[question.id] = {
    answers:
      pending.request.kind === "single-select"
        ? [selectedCodexOption(question, questionIndex, selected)]
        : [selected],
  };
  if (pending.mode !== "sequential") return undefined;
  pending.currentQuestion += 1;
  const next = pending.questions[pending.currentQuestion];
  return next
    ? codexQuestionInteraction(
        next,
        pending.currentQuestion,
        pending.expiresInMs,
      )
    : undefined;
}

function selectedCodexOption(
  question: CodexUserInputQuestion,
  questionIndex: number,
  selected: string | undefined,
): string {
  const match = new RegExp(`^option_${questionIndex}_(\\d+)$`).exec(
    selected ?? "",
  );
  const option = match ? question.options?.[Number(match[1])] : undefined;
  if (!option) throw new Error("Codex user-input option is invalid");
  return option.label;
}

function boundedProtocolText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= max && !/[\0]/.test(trimmed)
    ? trimmed
    : undefined;
}

function fitRuntimeText(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join("");
}

function parseDynamicToolCall(params: JsonObject): CodexDynamicToolCall {
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const callId = stringValue(params.callId);
  const tool = stringValue(params.tool);
  const namespace = params.namespace;
  if (
    !threadId ||
    !turnId ||
    !callId ||
    !tool ||
    (namespace !== null &&
      namespace !== undefined &&
      typeof namespace !== "string") ||
    !("arguments" in params)
  ) {
    throw new Error("Invalid dynamic tool call");
  }
  return {
    threadId,
    turnId,
    callId,
    namespace: typeof namespace === "string" ? namespace : null,
    tool,
    arguments: params.arguments as RuntimeJsonValue,
  };
}

function validateRuntimeTool(
  tool: RuntimeTool,
  existing: ReadonlyMap<string, RuntimeTool>,
): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
    throw new Error(`Invalid runtime tool name: ${tool.name}`);
  }
  if (!tool.description || tool.description.length > 1_024) {
    throw new Error(`Invalid runtime tool description: ${tool.name}`);
  }
  if (!isJsonObject(tool.inputSchema)) {
    throw new Error(
      `Runtime tool input schema must be an object: ${tool.name}`,
    );
  }
  const safeRead = tool.effect === "read-only" && tool.approval === "never";
  const gatedWrite =
    (tool.effect === "write" || tool.effect === "destructive") &&
    tool.approval === "required";
  if (!safeRead && !gatedWrite) {
    throw new Error(
      `Runtime tool effect and approval policy are incompatible: ${tool.name}`,
    );
  }
  if (existing.has(tool.name)) {
    throw new Error(`Duplicate runtime tool name: ${tool.name}`);
  }
}

function toCodexDynamicToolSpec(tool: RuntimeTool): CodexDynamicToolSpec {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function validateApprovalSummary(summary: string): void {
  if (
    typeof summary !== "string" ||
    summary.length === 0 ||
    summary.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(summary)
  ) {
    throw new Error("Runtime tool produced an invalid approval summary");
  }
}

function runtimeSessionCompatibilityId(
  tools: ReadonlyMap<string, RuntimeTool>,
): string {
  if (tools.size === 0) return "codex-app-server";
  const catalog = [...tools.values()].map((tool) => ({
    ...toCodexDynamicToolSpec(tool),
    effect: tool.effect,
    approval: tool.approval,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex")
    .slice(0, 16);
  return `codex-app-server:tools:${digest}`;
}

function validateToolResult(
  result: RuntimeToolResult,
  maxOutputBytes: number,
): void {
  if (
    !result ||
    typeof result.success !== "boolean" ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Runtime tool returned an invalid result");
  }
  let bytes = 0;
  for (const item of result.content) {
    const value = item.type === "text" ? item.text : item.url;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Runtime tool returned invalid content");
    }
    bytes += Buffer.byteLength(value);
    if (bytes > maxOutputBytes) {
      throw new Error("Runtime tool output exceeds configured limit");
    }
  }
}

function isJsonObject(
  value: RuntimeJsonValue,
): value is { [key: string]: RuntimeJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function httpOnlyProviderArgs(): string[] {
  return [
    "-c",
    'model_provider="wecom_http"',
    "-c",
    'model_providers.wecom_http.name="ChatGPT HTTP"',
    "-c",
    'model_providers.wecom_http.base_url="https://chatgpt.com/backend-api/codex"',
    "-c",
    'model_providers.wecom_http.wire_api="responses"',
    "-c",
    "model_providers.wecom_http.requires_openai_auth=true",
    "-c",
    "model_providers.wecom_http.supports_websockets=false",
  ];
}

function redactDiagnostic(value: string): string {
  return value
    .slice(0, 1_000)
    .replace(
      /((?:authorization|token|secret|api[_-]?key)["'\s:=]+)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}

async function waitFor(promise: Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Runtime tool execution timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
