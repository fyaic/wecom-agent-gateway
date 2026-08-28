import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Set<string>();
let sessionSequence = 0;
let turnSequence = 0;

const app = acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, (context) => ({
    protocolVersion: context.params.protocolVersion,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
    },
    agentInfo: { name: "Fake ACP Agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `fake-session-${++sessionSequence}`;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, (context) => {
    if (!sessions.has(context.params.sessionId)) {
      throw new Error("unknown session");
    }
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const { sessionId, prompt } = context.params;
    if (!sessions.has(sessionId)) throw new Error("unknown session");
    const text = prompt
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const hasImage = prompt.some((block) => block.type === "image");

    let reply: string;
    if (text.includes("permission")) {
      const result = await context.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId: "fake-tool-call",
            title: "Write a deterministic test artifact",
            name: "fake.write",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        },
      );
      reply =
        result.outcome.outcome === "selected"
          ? `permission:${result.outcome.optionId}`
          : "permission:cancelled";
    } else if (
      text.includes("[Quoted message context]\nearlier") &&
      text.includes("[End quoted message context]\ncurrent")
    ) {
      reply = "quote:received";
    } else if (hasImage) {
      reply = "image:received";
    } else {
      reply = `acp-turn-${++turnSequence}`;
    }

    const splitAt = Math.max(1, Math.floor(reply.length / 2));
    for (const chunk of [reply.slice(0, splitAt), reply.slice(splitAt)]) {
      if (!chunk) continue;
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);
await connection.closed;
