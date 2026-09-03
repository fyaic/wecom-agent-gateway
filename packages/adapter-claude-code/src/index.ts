import {
  RUNTIME_CONTRACT_VERSION,
  agentInputParts,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type RuntimeCapability,
} from "@fyaic/wecom-runtime-contract";

export interface ClaudeCodeQueryOptions {
  abortController: AbortController;
  cwd?: string;
  env: Record<string, string | undefined>;
  includePartialMessages: true;
  forwardSubagentText: false;
  model?: string;
  permissionMode: "dontAsk";
  resume?: string;
  settingSources: Array<"user" | "project" | "local">;
  tools: string[];
}

export interface ClaudeCodeQueryParameters {
  prompt: string;
  options: ClaudeCodeQueryOptions;
}

/** Injectable so protocol behavior is testable without credentials or a live model. */
export type ClaudeCodeQueryFactory = (
  parameters: ClaudeCodeQueryParameters,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface ClaudeCodeRuntimeAdapterOptions {
  workingDirectory?: string;
  model?: string;
  /**
   * Complete environment passed to the Claude Code subprocess. It is not merged
   * with the Gateway environment. Credentials remain user-owned and opt-in.
   */
  environment?: Record<string, string | undefined>;
  /** Filesystem settings are disabled by default for an isolated Adapter. */
  settingSources?: Array<"user" | "project" | "local">;
  queryFactory?: ClaudeCodeQueryFactory;
}

export class ClaudeCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "claude-code";
  readonly contractVersion = RUNTIME_CONTRACT_VERSION;
  readonly sessionCompatibilityId = "claude-agent-sdk:0.3";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "streaming",
    "resume",
    "cancel",
    "quoted-context",
  ]);

  private readonly queryFactory: ClaudeCodeQueryFactory;
  private readonly usesOfficialSdk: boolean;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly options: ClaudeCodeRuntimeAdapterOptions = {}) {
    assertSafeEnvironment(options.environment);
    this.usesOfficialSdk = options.queryFactory === undefined;
    this.queryFactory = options.queryFactory ?? defaultClaudeCodeQueryFactory;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    let prompt: string;
    try {
      prompt = buildTextPrompt(request);
    } catch {
      yield {
        type: "failed",
        message: "Claude Code Adapter currently accepts text input only",
      };
      return;
    }

    const abortController = new AbortController();
    let activeSessionId = request.sessionId;
    if (activeSessionId) this.activeRuns.set(activeSessionId, abortController);

    let terminal = false;
    let partialText = "";
    try {
      const stream = await this.queryFactory({
        prompt,
        options: {
          abortController,
          cwd: this.options.workingDirectory,
          env: this.options.environment ?? {
            CLAUDE_AGENT_SDK_CLIENT_APP: "wecom-agent-gateway/0.1.0",
          },
          includePartialMessages: true,
          forwardSubagentText: false,
          model: this.options.model,
          permissionMode: "dontAsk",
          resume: request.sessionId,
          settingSources: this.options.settingSources ?? [],
          tools: [],
        },
      });

      for await (const raw of stream) {
        if (terminal) continue;
        const message = asRecord(raw);
        if (!message) continue;

        if (isInitMessage(message)) {
          const sessionId = stringField(message, "session_id");
          if (!sessionId) continue;
          if (
            request.sessionId !== undefined &&
            sessionId !== request.sessionId
          ) {
            terminal = true;
            yield {
              type: "failed",
              message: "Claude Code resumed a different session",
            };
            continue;
          }
          if (activeSessionId && activeSessionId !== sessionId) {
            this.releaseRun(activeSessionId, abortController);
          }
          activeSessionId = sessionId;
          this.activeRuns.set(sessionId, abortController);
          yield { type: "session-started", sessionId };
          continue;
        }

        const delta = textDelta(message);
        if (delta !== undefined) {
          partialText += delta;
          if (delta) yield { type: "text-delta", text: delta };
          continue;
        }

        if (message.type === "result") {
          terminal = true;
          if (
            message.subtype === "success" &&
            message.is_error === false &&
            typeof message.result === "string"
          ) {
            if (partialText && partialText !== message.result) {
              yield {
                type: "failed",
                message: "Claude Code stream did not match its final result",
              };
            } else {
              yield { type: "message-completed", text: message.result };
            }
          } else {
            yield { type: "failed", message: classifyResultFailure(message) };
          }
        }
      }
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield {
          type: "failed",
          message: abortController.signal.aborted
            ? "Claude Code request cancelled"
            : classifyThrownFailure(error),
        };
      }
    } finally {
      if (activeSessionId) this.releaseRun(activeSessionId, abortController);
    }

    if (!terminal) {
      yield {
        type: "failed",
        message: abortController.signal.aborted
          ? "Claude Code request cancelled"
          : "Claude Code stream ended without a result",
      };
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.activeRuns.get(sessionId)?.abort();
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (this.usesOfficialSdk) {
      try {
        await import("@anthropic-ai/claude-agent-sdk");
      } catch {
        return {
          ok: false,
          detail: "Optional Claude Agent SDK package is unavailable",
        };
      }
    }
    return {
      ok: true,
      detail:
        "Claude Agent SDK is configured; credentials are checked when a run starts",
    };
  }

  private releaseRun(
    sessionId: string,
    abortController: AbortController,
  ): void {
    if (this.activeRuns.get(sessionId) === abortController) {
      this.activeRuns.delete(sessionId);
    }
  }
}

function buildTextPrompt(request: AgentRunRequest): string {
  const parts = agentInputParts(request.message);
  if (parts.length === 0 || parts.some((part) => part.type !== "text")) {
    throw new Error("unsupported-input");
  }
  return parts
    .map((part) => {
      if (part.type !== "text") throw new Error("unsupported-input");
      return part.text;
    })
    .join("\n");
}

async function defaultClaudeCodeQueryFactory(
  parameters: ClaudeCodeQueryParameters,
): Promise<AsyncIterable<unknown>> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query(parameters);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isInitMessage(message: Record<string, unknown>): boolean {
  return message.type === "system" && message.subtype === "init";
}

function textDelta(message: Record<string, unknown>): string | undefined {
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) {
    return undefined;
  }
  const event = asRecord(message.event);
  if (event?.type !== "content_block_delta") return undefined;
  const delta = asRecord(event.delta);
  return delta?.type === "text_delta" && typeof delta.text === "string"
    ? delta.text
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function classifyResultFailure(message: Record<string, unknown>): string {
  const subtype = stringField(message, "subtype");
  const result = stringField(message, "result")?.toLowerCase();
  if (
    result?.includes("not logged in") ||
    result?.includes("please run /login")
  ) {
    return "Claude Code authentication is unavailable";
  }
  if (subtype === "error_max_turns")
    return "Claude Code reached its turn limit";
  if (subtype === "error_max_budget_usd") {
    return "Claude Code reached its budget limit";
  }
  if (subtype === "error_max_structured_output_retries") {
    return "Claude Code could not produce the required output";
  }
  return "Claude Code request failed";
}

function classifyThrownFailure(error: unknown): string {
  const name =
    error !== null && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "AbortError") return "Claude Code request cancelled";
  return "Claude Code process failed";
}

function assertSafeEnvironment(
  environment: Record<string, string | undefined> | undefined,
): void {
  if (!environment) return;
  const containsForbiddenCredential = Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      value !== "" &&
      (name === "CLAUDE_CODE_OAUTH_TOKEN" ||
        name === "ANTHROPIC_AUTH_TOKEN" ||
        name.startsWith("WECOM_") ||
        name.startsWith("GATEWAY_")),
  );
  if (containsForbiddenCredential) {
    throw new Error(
      "Claude Code subprocess environment contains a forbidden host or session credential",
    );
  }
}
