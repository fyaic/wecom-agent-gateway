import { randomUUID } from "node:crypto";
import {
  defineRuntimeAdapter,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
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
  readonly capabilities = new Set(["streaming", "resume"] as const);

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
