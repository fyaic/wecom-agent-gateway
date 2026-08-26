import { randomUUID } from "node:crypto";
import {
  defineRuntimeAdapter,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type AgentInteractionResumeRequest,
  type RuntimeAdapterFactoryContext,
} from "@fyaic/wecom-adapter-sdk";

/**
 * Replace this deterministic echo Kernel with the target Agent's SDK/RPC.
 * Do not import WeCom SDK types or make routing/model decisions here.
 */
class ExampleRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "example";
  readonly contractVersion = 1 as const;
  readonly sessionCompatibilityId = "example:v1";
  readonly capabilities = new Set([
    "streaming",
    "resume",
    "interaction-resume",
    "reply-actions",
  ] as const);
  private readonly completedInteractionResumes = new Set<string>();

  constructor(private readonly prefix: string) {}

  async *run(request: AgentRunRequest) {
    const sessionId = request.sessionId ?? randomUUID();
    if (!request.sessionId)
      yield { type: "session-started", sessionId } as const;
    const input = request.message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const text = `${this.prefix}${input}`;
    yield { type: "text-delta", text } as const;
    yield { type: "message-completed", text } as const;
  }

  async *resumeInteraction(request: AgentInteractionResumeRequest) {
    if (this.completedInteractionResumes.has(request.idempotencyKey)) return;
    if (
      request.interaction.kind !== "actions" ||
      request.interaction.resumeMode !== "new-turn" ||
      !request.message
    ) {
      throw new Error("Example Adapter only supports new-turn reply actions");
    }
    yield* this.run({
      message: request.message,
      sessionId: request.sessionId,
    });
    this.completedInteractionResumes.add(request.idempotencyKey);
    if (this.completedInteractionResumes.size > 1_000) {
      const oldest = this.completedInteractionResumes.values().next().value;
      if (oldest !== undefined) this.completedInteractionResumes.delete(oldest);
    }
  }

  async health() {
    return { ok: true };
  }
}

export default defineRuntimeAdapter(
  async (context: RuntimeAdapterFactoryContext) => {
    const prefix = context.config.prefix;
    if (prefix !== undefined && typeof prefix !== "string") {
      throw new Error("Example Adapter config.prefix must be a string");
    }
    return new ExampleRuntimeAdapter(prefix ?? "echo: ");
  },
);
