import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  RUNTIME_CONTRACT_VERSION,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type MediaType,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

type JsonRecord = Record<string, unknown>;

export interface PiRpcResponse<T = unknown> {
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
  id?: string;
}

export interface PiRpcClientHandlers {
  onEvent(event: JsonRecord): void;
  onError(error: Error): void;
}

export interface PiRpcClient {
  start(): Promise<void>;
  request<T = unknown>(command: JsonRecord): Promise<PiRpcResponse<T>>;
  send(command: JsonRecord): Promise<void>;
  stop(): Promise<void>;
}

export interface PiRuntimeAdapterOptions {
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
  sessionRoots?: string[];
  onStderr?: (message: string) => void;
  clientFactory?: (handlers: PiRpcClientHandlers) => PiRpcClient;
}

export interface PooledPiRuntimeAdapterOptions extends PiRuntimeAdapterOptions {
  maxWorkers?: number;
  workerFactory?: (index: number) => AgentRuntimeAdapter;
}

interface PiSessionState {
  sessionFile: string;
  sessionId: string;
}

interface ActiveRun {
  sessionId: string;
  queue: AsyncEventQueue;
  text: string;
  settling: boolean;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const SESSION_PREFIX = "pi-rpc-v1:";
// Pi's prompt command and some OpenAI-compatible vision providers require a
// non-empty string beside `images`. A single space carries no user intent and
// is transport framing, not an instruction or an image-to-text placeholder.
const IMAGE_ONLY_MESSAGE_PADDING = " ";

/**
 * Pi's official JSONL RPC adapter. One managed child process is deliberately
 * shared and turns are serialized because the protocol has one active session.
 */
export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "pi";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId = "pi:rpc-v1";
  private readonly mutableCapabilities = new Set<RuntimeCapability>([
    "streaming",
    "resume",
    "cancel",
    "status-events",
  ]);
  readonly capabilities: ReadonlySet<RuntimeCapability> =
    this.mutableCapabilities;
  readonly inputModalities: ReadonlySet<MediaType>;
  private readonly mutableInputModalities = new Set<MediaType>();

  private readonly requestTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly configuredRoots: string[];
  private readonly clientFactory: (
    handlers: PiRpcClientHandlers,
  ) => PiRpcClient;
  private readonly mutex = new AsyncMutex();
  private client?: PiRpcClient;
  private startPromise?: Promise<void>;
  private processError?: Error;
  private active?: ActiveRun;
  private currentState?: PiSessionState;
  private inferredSessionRoot?: string;

  constructor(private readonly options: PiRuntimeAdapterOptions = {}) {
    this.inputModalities = this.mutableInputModalities;
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
    this.configuredRoots = (options.sessionRoots ?? []).map((root) =>
      resolve(root),
    );
    this.clientFactory =
      options.clientFactory ??
      ((handlers) =>
        new SpawnedPiRpcClient({
          executable: options.executable ?? "pi",
          args: ["--mode", "rpc", ...(options.args ?? [])],
          cwd: resolve(options.cwd ?? process.cwd()),
          env: options.env,
          requestTimeoutMs: this.requestTimeoutMs,
          onStderr: options.onStderr,
          handlers,
        }));
  }

  async start(): Promise<void> {
    if (this.client && !this.processError) return;
    if (this.startPromise) return this.startPromise;
    this.processError = undefined;
    this.startPromise = (async () => {
      const client = this.clientFactory({
        onEvent: (event) => this.handleEvent(event),
        onError: (error) => {
          this.processError = error;
          this.active?.queue.fail(error);
        },
      });
      this.client = client;
      try {
        await client.start();
        const state = await this.getState();
        this.currentState = state;
        this.inferredSessionRoot = dirname(resolve(state.sessionFile));
      } catch (error) {
        await client.stop().catch(() => undefined);
        if (this.client === client) this.client = undefined;
        throw error;
      }
    })().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.currentState = undefined;
    this.processError = undefined;
    this.active?.queue.fail(new Error("Pi RPC adapter stopped"));
    this.active = undefined;
    await client?.stop();
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    let release: (() => void) | undefined;
    try {
      await this.start();
      release = await this.mutex.acquire();
      const state = request.sessionId
        ? await this.resumeSession(request.sessionId)
        : await this.createSession();
      const opaqueSessionId = encodeSession(state);
      if (!request.sessionId) {
        yield { type: "session-started", sessionId: opaqueSessionId };
      }
      yield { type: "status", phase: "accepted" };

      const queue = new AsyncEventQueue();
      const active: ActiveRun = {
        sessionId: opaqueSessionId,
        queue,
        text: "",
        settling: false,
      };
      this.active = active;
      const timer = setTimeout(() => {
        void this.client?.request({ type: "abort" }).catch(() => undefined);
        queue.fail(new Error("Pi RPC run timed out"));
      }, this.runTimeoutMs);

      try {
        const prompt = await this.toPrompt(request);
        await this.command({ type: "prompt", ...prompt });
        for await (const event of queue) yield event;
      } catch (error) {
        await this.client?.request({ type: "abort" }).catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
        if (this.active === active) this.active = undefined;
      }
    } catch (error) {
      yield { type: "failed", message: safeErrorMessage(error) };
    } finally {
      release?.();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.active?.sessionId !== sessionId || !this.client) return;
    await this.command({ type: "abort" });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (this.processError)
      return { ok: false, detail: "Pi RPC process failed" };
    if (!this.client || !this.currentState) {
      return { ok: false, detail: "Pi RPC process is not started" };
    }
    try {
      await this.getState();
      return { ok: true, detail: "Pi connected over official JSONL RPC" };
    } catch {
      return { ok: false, detail: "Pi RPC health probe failed" };
    }
  }

  private async createSession(): Promise<PiSessionState> {
    const response = await this.command<{ cancelled?: boolean }>({
      type: "new_session",
    });
    if (response.data?.cancelled)
      throw new Error("Pi session creation cancelled");
    const state = await this.getState();
    this.assertAllowedSessionPath(state.sessionFile);
    this.currentState = state;
    return state;
  }

  private async resumeSession(opaqueId: string): Promise<PiSessionState> {
    const expected = decodeSession(opaqueId);
    this.assertAllowedSessionPath(expected.sessionFile);
    if (
      this.currentState?.sessionFile !== expected.sessionFile ||
      this.currentState.sessionId !== expected.sessionId
    ) {
      const response = await this.command<{ cancelled?: boolean }>({
        type: "switch_session",
        sessionPath: expected.sessionFile,
      });
      if (response.data?.cancelled)
        throw new Error("Pi session switch cancelled");
    }
    const actual = await this.getState();
    if (
      resolve(actual.sessionFile) !== resolve(expected.sessionFile) ||
      actual.sessionId !== expected.sessionId
    ) {
      throw new Error("Pi resumed a different session");
    }
    this.currentState = actual;
    return actual;
  }

  private async getState(): Promise<PiSessionState> {
    const response = await this.command<JsonRecord>({ type: "get_state" });
    const sessionFile = stringValue(response.data?.sessionFile);
    const sessionId = stringValue(response.data?.sessionId);
    if (!sessionFile || !sessionId || !isAbsolute(sessionFile)) {
      throw new Error("Pi RPC did not provide a persistent session");
    }
    const model = recordValue(response.data?.model);
    const inputs = Array.isArray(model?.input) ? model.input : [];
    if (inputs.includes("image")) {
      this.mutableCapabilities.add("multimodal-input");
      this.mutableInputModalities.add("image");
    } else {
      this.mutableCapabilities.delete("multimodal-input");
      this.mutableInputModalities.delete("image");
    }
    return { sessionFile: resolve(sessionFile), sessionId };
  }

  private async command<T = unknown>(
    command: JsonRecord,
  ): Promise<PiRpcResponse<T>> {
    if (!this.client) throw new Error("Pi RPC adapter is not started");
    const response = await this.client.request<T>(command);
    if (!response.success) {
      throw new Error(`Pi RPC command ${response.command} failed`);
    }
    return response;
  }

  private async toPrompt(
    request: AgentRunRequest,
  ): Promise<{ message: string; images?: JsonRecord[] }> {
    const text: string[] = [];
    const images: JsonRecord[] = [];
    for (const part of request.message.parts) {
      if (part.type === "text") {
        text.push(part.text);
      } else if (part.type === "image" && part.path) {
        if (!this.capabilities.has("multimodal-input")) {
          throw new Error("Configured Pi model cannot accept image input");
        }
        images.push({
          type: "image",
          data: (await readFile(part.path)).toString("base64"),
          mimeType: part.mimeType ?? "application/octet-stream",
        });
      } else {
        throw new Error(`Pi RPC cannot accept ${part.type} input`);
      }
    }
    if (text.length === 0 && images.length === 0) {
      throw new Error("Pi RPC prompt has no supported content");
    }
    const message = text.join("\n");
    return {
      message: message.length > 0 ? message : IMAGE_ONLY_MESSAGE_PADDING,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  private handleEvent(event: JsonRecord): void {
    if (event.type === "extension_ui_request") {
      const id = stringValue(event.id);
      const method = stringValue(event.method);
      if (id && method && DIALOG_METHODS.has(method)) {
        void this.client
          ?.send({ type: "extension_ui_response", id, cancelled: true })
          .catch((error: unknown) => this.active?.queue.fail(asError(error)));
      } else if (method === "setStatus") {
        const text = stringValue(event.statusText);
        if (text) {
          this.active?.queue.push({ type: "status", phase: "custom", text });
        }
      }
      return;
    }

    const active = this.active;
    if (!active) return;
    if (event.type === "agent_start") {
      active.queue.push({ type: "status", phase: "thinking" });
      return;
    }
    if (event.type === "tool_execution_start") {
      active.queue.push({ type: "status", phase: "tool-running" });
      return;
    }
    if (event.type === "message_update") {
      const delta = recordValue(event.assistantMessageEvent);
      const deltaType = stringValue(delta?.type);
      if (deltaType === "text_delta") {
        const text = stringValue(delta?.delta);
        if (text) {
          active.text += text;
          active.queue.push({ type: "text-delta", text });
        }
      } else if (deltaType === "thinking_start") {
        active.queue.push({ type: "status", phase: "thinking" });
      } else if (deltaType === "toolcall_start") {
        active.queue.push({ type: "status", phase: "tool-running" });
      }
      return;
    }
    if (event.type === "agent_settled" && !active.settling) {
      active.settling = true;
      void this.completeActiveRun(active);
    }
  }

  private async completeActiveRun(active: ActiveRun): Promise<void> {
    try {
      const response = await this.command<{ text?: string | null }>({
        type: "get_last_assistant_text",
      });
      const authoritative =
        typeof response.data?.text === "string" ? response.data.text : "";
      if (!active.text && authoritative) {
        active.text = authoritative;
        active.queue.push({ type: "text-delta", text: authoritative });
      } else if (authoritative.startsWith(active.text)) {
        const suffix = authoritative.slice(active.text.length);
        if (suffix) {
          active.text = authoritative;
          active.queue.push({ type: "text-delta", text: suffix });
        }
      }
      if (!active.text) {
        active.queue.fail(new Error("Pi RPC completed without assistant text"));
        return;
      }
      active.queue.push({ type: "message-completed", text: active.text });
      active.queue.end();
    } catch (error) {
      active.queue.fail(asError(error));
    }
  }

  private assertAllowedSessionPath(sessionFile: string): void {
    const candidate = resolve(sessionFile);
    const roots = [
      ...this.configuredRoots,
      ...(this.inferredSessionRoot ? [this.inferredSessionRoot] : []),
    ];
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new Error("Pi session is outside configured storage roots");
    }
  }
}

/**
 * Bounded process pool for Pi's single-current-session RPC runtime. Session
 * ordering is retained per opaque session while unrelated sessions may use
 * different workers concurrently.
 */
export class PooledPiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "pi";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId = "pi:rpc-v1";
  readonly maxWorkers: number;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly inputModalities: ReadonlySet<MediaType>;

  private readonly mutableCapabilities = new Set<RuntimeCapability>();
  private readonly mutableInputModalities = new Set<MediaType>();
  private readonly workers: AgentRuntimeAdapter[];
  private readonly available: AgentRuntimeAdapter[] = [];
  private readonly workerWaiters: Array<(worker: AgentRuntimeAdapter) => void> =
    [];
  private readonly activeSessions = new Map<string, AgentRuntimeAdapter>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private startPromise?: Promise<void>;
  private started = false;

  constructor(options: PooledPiRuntimeAdapterOptions = {}) {
    this.maxWorkers = positiveInteger(options.maxWorkers, 2, "maxWorkers");
    this.capabilities = this.mutableCapabilities;
    this.inputModalities = this.mutableInputModalities;
    const {
      maxWorkers: _maxWorkers,
      workerFactory,
      ...workerOptions
    } = options;
    this.workers = Array.from({ length: this.maxWorkers }, (_, index) =>
      workerFactory
        ? workerFactory(index)
        : new PiRuntimeAdapter(workerOptions),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        await Promise.all(this.workers.map((worker) => worker.start?.()));
        this.validateWorkers();
        this.syncCapabilities();
        this.available.splice(0, this.available.length, ...this.workers);
        this.started = true;
      } catch (error) {
        await Promise.allSettled(this.workers.map((worker) => worker.stop?.()));
        throw error;
      }
    })().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.available.length = 0;
    this.activeSessions.clear();
    await Promise.allSettled(this.workers.map((worker) => worker.stop?.()));
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    await this.start();
    const lockKey = request.sessionId ?? `new:${randomUUID()}`;
    const releaseSession = await this.acquireSession(lockKey);
    const worker = await this.acquireWorker();
    let activeSessionId = request.sessionId;
    if (activeSessionId) this.activeSessions.set(activeSessionId, worker);
    try {
      for await (const event of worker.run(request)) {
        if (event.type === "session-started") {
          activeSessionId = event.sessionId;
          this.activeSessions.set(event.sessionId, worker);
        }
        yield event;
      }
    } finally {
      if (
        activeSessionId &&
        this.activeSessions.get(activeSessionId) === worker
      ) {
        this.activeSessions.delete(activeSessionId);
      }
      this.releaseWorker(worker);
      releaseSession();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const worker = this.activeSessions.get(sessionId);
    await worker?.cancel?.(sessionId);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "Pi worker pool is not started" };
    }
    const health = await Promise.all(
      this.workers.map((worker) => worker.health()),
    );
    const healthy = health.filter((item) => item.ok).length;
    return healthy === this.workers.length
      ? {
          ok: true,
          detail: `Pi worker pool healthy (${healthy}/${this.workers.length})`,
        }
      : {
          ok: false,
          detail: `Pi worker pool degraded (${healthy}/${this.workers.length})`,
        };
  }

  private validateWorkers(): void {
    for (const worker of this.workers) {
      if (
        worker.id !== this.id ||
        worker.contractVersion !== this.contractVersion ||
        worker.sessionCompatibilityId !== this.sessionCompatibilityId
      ) {
        throw new Error("Pi worker uses an incompatible runtime contract");
      }
    }
    const first = this.workers[0]!;
    for (const worker of this.workers.slice(1)) {
      if (
        !sameSet(first.capabilities, worker.capabilities) ||
        !sameSet(
          first.inputModalities ?? new Set<MediaType>(),
          worker.inputModalities ?? new Set<MediaType>(),
        )
      ) {
        throw new Error("Pi workers disagree on model capabilities");
      }
    }
  }

  private syncCapabilities(): void {
    const first = this.workers[0]!;
    this.mutableCapabilities.clear();
    for (const capability of first.capabilities) {
      this.mutableCapabilities.add(capability);
    }
    this.mutableInputModalities.clear();
    for (const modality of first.inputModalities ?? []) {
      this.mutableInputModalities.add(modality);
    }
  }

  private acquireWorker(): Promise<AgentRuntimeAdapter> {
    const worker = this.available.shift();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolveWorker) => {
      this.workerWaiters.push(resolveWorker);
    });
  }

  private releaseWorker(worker: AgentRuntimeAdapter): void {
    const waiter = this.workerWaiters.shift();
    if (waiter) waiter(worker);
    else if (this.started) this.available.push(worker);
  }

  private async acquireSession(key: string): Promise<() => void> {
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const tail = previous.then(() => current);
    this.sessionLocks.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.sessionLocks.get(key) === tail) this.sessionLocks.delete(key);
    };
  }
}

interface SpawnedPiRpcClientOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  onStderr?: (message: string) => void;
  handlers: PiRpcClientHandlers;
}

/** Process client kept public for protocol-level tests and non-Gateway reuse. */
export class SpawnedPiRpcClient implements PiRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: PiRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private decoder?: StrictJsonlDecoder;

  constructor(private readonly options: SpawnedPiRpcClientOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.decoder = new StrictJsonlDecoder(
      (line) => this.handleLine(line),
      (error) => this.fail(error),
    );
    child.stdout.on("data", (chunk: Buffer) => this.decoder?.push(chunk));
    child.stdout.once("end", () => this.decoder?.end());
    child.stderr.on("data", (chunk: Buffer) => {
      const message = bounded(chunk.toString("utf8").trim(), 1_000);
      if (message) this.options.onStderr?.(message);
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => this.fail(new Error("Pi RPC process exited")));
    await new Promise<void>((resolveStart, rejectStart) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolveStart();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        rejectStart(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async request<T = unknown>(command: JsonRecord): Promise<PiRpcResponse<T>> {
    const id = randomUUID();
    const promise = new Promise<PiRpcResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pi RPC request timed out"));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveResponse, reject, timer });
    });
    try {
      await this.send({ ...command, id });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return (await promise) as PiRpcResponse<T>;
  }

  async send(command: JsonRecord): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("Pi RPC process is not writable");
    }
    const line = `${JSON.stringify(command)}\n`;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(line, (error) =>
        error ? rejectWrite(error) : resolveWrite(),
      );
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.rejectPending(new Error("Pi RPC client stopped"));
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

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Pi RPC emitted invalid JSON"));
      return;
    }
    if (!isRecord(value)) {
      this.fail(new Error("Pi RPC emitted a non-object record"));
      return;
    }
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      pending.resolve(value as unknown as PiRpcResponse);
      return;
    }
    this.options.handlers.onEvent(value);
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.options.handlers.onError(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Strict LF framing; U+2028/U+2029 are ordinary JSON string characters. */
export class StrictJsonlDecoder {
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  push(chunk: Buffer | Uint8Array): void {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    if (
      Buffer.byteLength(this.buffer, "utf8") >
      StrictJsonlDecoder.MAX_BUFFER_BYTES
    ) {
      this.buffer = "";
      this.onError(new Error("Pi RPC JSONL record exceeds the size limit"));
      return;
    }
    this.drain();
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drain();
    if (this.buffer) {
      this.onError(
        new Error("Pi RPC stdout ended with an incomplete JSONL record"),
      );
      this.buffer = "";
    }
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.onLine(line);
    }
  }
}

class AsyncEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly values: AgentRunEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<AgentRunEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private settled = false;
  private error?: Error;

  push(value: AgentRunEvent): void {
    if (this.settled) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.settled) return;
    this.settled = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.settled) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolveNext, reject) => {
          this.waiters.push({ resolve: resolveNext, reject });
        });
      },
    };
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    return release;
  }
}

function encodeSession(state: PiSessionState): string {
  return `${SESSION_PREFIX}${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
}

function decodeSession(value: string): PiSessionState {
  if (!value.startsWith(SESSION_PREFIX))
    throw new Error("Invalid Pi session id");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(SESSION_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("Invalid Pi session id");
  }
  if (!isRecord(parsed)) throw new Error("Invalid Pi session id");
  const sessionFile = stringValue(parsed.sessionFile);
  const sessionId = stringValue(parsed.sessionId);
  if (!sessionFile || !sessionId || !isAbsolute(sessionFile)) {
    throw new Error("Invalid Pi session id");
  }
  return { sessionFile: resolve(sessionFile), sessionId };
}

function isWithin(root: string, path: string): boolean {
  const result = relative(resolve(root), resolve(path));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`Pi ${name} must be a positive integer`);
  }
  return selected;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safeErrorMessage(value: unknown): string {
  const message = asError(value).message;
  return bounded(message.replaceAll(/[\\/][^\s]+/g, "[path]"), 500);
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
