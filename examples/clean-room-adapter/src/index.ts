import { randomUUID } from "node:crypto";
import {
  agentInputParts,
  defineRuntimeAdapter,
  type AgentInteractionResumeRequest,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type RuntimeAdapterFactoryContext,
} from "@fyaic/wecom-adapter-sdk";

class CleanRoomEchoAdapter implements AgentRuntimeAdapter {
  readonly id = "clean-room-echo";
  readonly contractVersion = 1 as const;
  readonly sessionCompatibilityId = "clean-room-echo:v1";
  readonly capabilities = new Set([
    "streaming",
    "resume",
    "cancel",
    "multimodal-input",
    "quoted-context",
    "interaction-resume",
    "reply-actions",
  ] as const);
  readonly inputModalities = new Set(["image"] as const);
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly completedInteractions = new Set<string>();

  constructor(private readonly prefix: string) {}

  async *run(request: AgentRunRequest) {
    const sessionId = request.sessionId ?? randomUUID();
    this.active.add(sessionId);
    try {
      if (!request.sessionId)
        yield { type: "session-started", sessionId } as const;
      const input = agentInputParts(request.message)
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join(" ");
      const text = `${this.prefix}${input}`;
      yield { type: "text-delta", text } as const;
      await Promise.resolve();
      if (this.cancelled.delete(sessionId)) {
        yield { type: "failed", message: "Cancelled" } as const;
        return;
      }
      yield { type: "message-completed", text } as const;
    } finally {
      this.active.delete(sessionId);
      this.cancelled.delete(sessionId);
    }
  }

  async cancel(sessionId: string) {
    if (this.active.has(sessionId)) this.cancelled.add(sessionId);
  }

  async *resumeInteraction(request: AgentInteractionResumeRequest) {
    if (this.completedInteractions.has(request.idempotencyKey)) return;
    if (
      request.interaction.kind !== "actions" ||
      request.interaction.resumeMode !== "new-turn" ||
      !request.message
    ) {
      throw new Error("Only new-turn reply actions are supported");
    }
    yield* this.run({ message: request.message, sessionId: request.sessionId });
    this.completedInteractions.add(request.idempotencyKey);
  }

  async health() {
    return { ok: true };
  }
}

export default defineRuntimeAdapter(
  async (context: RuntimeAdapterFactoryContext) => {
    const prefix = context.config.prefix;
    if (prefix !== undefined && typeof prefix !== "string") {
      throw new Error("config.prefix must be a string");
    }
    return new CleanRoomEchoAdapter(prefix ?? "echo: ");
  },
);
