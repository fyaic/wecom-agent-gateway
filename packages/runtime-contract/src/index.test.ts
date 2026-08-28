import { describe, expect, it } from "vitest";
import { agentInputParts, type InboundMessage } from "./index.js";

describe("agentInputParts", () => {
  it("preserves structured quoted content before the current message", () => {
    const message: InboundMessage = {
      id: "message-1",
      accountId: "bot",
      conversationId: "chat",
      conversationType: "direct",
      senderId: "user",
      receivedAt: "2026-08-28T00:00:00.000Z",
      quote: {
        parts: [
          { type: "text", text: "Earlier context" },
          { type: "image", path: "/protected/quoted.png" },
        ],
      },
      parts: [{ type: "text", text: "What does this mean?" }],
    };

    expect(agentInputParts(message)).toEqual([
      { type: "text", text: "[Quoted message context]" },
      { type: "text", text: "Earlier context" },
      { type: "image", path: "/protected/quoted.png" },
      { type: "text", text: "[End quoted message context]" },
      { type: "text", text: "What does this mean?" },
    ]);
  });

  it("does not alter messages without a quote", () => {
    const parts: InboundMessage["parts"] = [{ type: "text", text: "hello" }];
    const message = {
      id: "message-2",
      accountId: "bot",
      conversationId: "chat",
      conversationType: "direct" as const,
      senderId: "user",
      receivedAt: "2026-08-28T00:00:00.000Z",
      parts,
    };
    expect(agentInputParts(message)).toBe(parts);
  });
});
