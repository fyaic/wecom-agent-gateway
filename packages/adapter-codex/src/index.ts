import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
} from "@openai/codex-sdk";
import {
  agentInputParts,
  RUNTIME_CONTRACT_VERSION,
  type AgentInteractionResumeRequest,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

export {
  CodexAppServerClient,
  CodexAppServerRuntimeAdapter,
  type CodexAppServerClientLike,
  type CodexAppServerClientOptions,
  type CodexDynamicToolCall,
  type CodexDynamicToolCallResult,
  type CodexDynamicToolSpec,
  type CodexUserInputOption,
  type CodexUserInputQuestion,
  type CodexUserInputResponse,
  type RuntimeToolLifecycleEvent,
  type CodexAppServerEvent,
  type CodexAppServerInput,
  type CodexAppServerRuntimeAdapterOptions,
  type CodexAppServerThreadOptions,
  type CodexAppServerTurnOptions,
} from "./app-server.js";

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(prompt: string): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

interface CodexClientLike {
  startThread(options: CodexThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike;
}

interface CodexThreadOptions {
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
}

export interface CodexRuntimeAdapterOptions {
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  client?: CodexClientLike;
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "codex";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
    "interaction-resume",
    "reply-actions",
    "quoted-context",
  ]);
  private readonly codex: CodexClientLike;
  private readonly completedInteractionResumes = new Set<string>();

  constructor(private readonly options: CodexRuntimeAdapterOptions = {}) {
    this.codex = options.client ?? (new Codex() as CodexClientLike);
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const threadOptions: CodexThreadOptions = {
      workingDirectory: this.options.workingDirectory,
      model: this.options.model,
      modelReasoningEffort: this.options.modelReasoningEffort,
    };
    const thread = request.sessionId
      ? this.codex.resumeThread(request.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);
    const prompt = agentInputParts(request.message)
      .map((part) =>
        part.type === "text"
          ? part.text
          : `[${part.type}] ${part.name ?? part.url ?? "附件"}`,
      )
      .join("\n");
    const streamed = await thread.runStreamed(prompt);
    const snapshots = new Map<string, string>();
    let finalText = "";
    let completed = false;
    let lastStreamError: string | undefined;
    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        yield { type: "session-started", sessionId: event.thread_id };
      } else if (
        event.type === "item.updated" &&
        event.item.type === "agent_message"
      ) {
        const previous = snapshots.get(event.item.id) ?? "";
        snapshots.set(event.item.id, event.item.text);
        if (event.item.text.startsWith(previous)) {
          const delta = event.item.text.slice(previous.length);
          if (delta) yield { type: "text-delta", text: delta };
        }
      } else if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      ) {
        snapshots.set(event.item.id, event.item.text);
        finalText = event.item.text;
      } else if (event.type === "turn.completed") {
        completed = true;
        yield { type: "message-completed", text: finalText || undefined };
      } else if (event.type === "turn.failed") {
        yield { type: "failed", message: event.error.message };
      } else if (event.type === "error") {
        // Codex can emit reconnect notices as error events and later complete the turn.
        // Preserve the latest error, but do not prematurely terminate a recoverable stream.
        lastStreamError = event.message;
      }
    }
    if (!completed && lastStreamError) {
      yield { type: "failed", message: lastStreamError };
    }
  }

  async *resumeInteraction(
    request: AgentInteractionResumeRequest,
  ): AsyncIterable<AgentRunEvent> {
    if (this.completedInteractionResumes.has(request.idempotencyKey)) return;
    assertReplyActionContinuation(request, "Codex");
    yield* this.run({
      message: request.message!,
      sessionId: request.sessionId,
    });
    rememberBounded(
      this.completedInteractionResumes,
      request.idempotencyKey,
      1_000,
    );
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return {
      ok: true,
      detail: "Codex SDK loaded; authentication is checked when a run starts",
    };
  }
}

function assertReplyActionContinuation(
  request: AgentInteractionResumeRequest,
  adapter: string,
): void {
  if (
    request.interaction.kind !== "actions" ||
    request.interaction.resumeMode !== "new-turn" ||
    !request.message
  ) {
    throw new Error(`${adapter} only supports new-turn reply actions`);
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
