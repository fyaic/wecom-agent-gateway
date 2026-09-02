import { describe, expect, it } from "vitest";
import {
  CHANNEL_TRANSPORT_CONTRACT_VERSION,
  agentInputParts,
  assertChannelTransportCompatible,
  type ChannelTransport,
  type InboundMessage,
} from "./index.js";

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

describe("assertChannelTransportCompatible", () => {
  const compatible = {
    id: "reference-transport",
    contractVersion: CHANNEL_TRANSPORT_CONTRACT_VERSION,
    capabilities: new Set(),
    async start() {},
    async stop() {},
    async deliver() {
      return { id: "receipt", acceptedAt: new Date(0).toISOString() };
    },
    async health() {
      return { ok: true };
    },
  } satisfies ChannelTransport;

  it("accepts a v1 Transport", () => {
    expect(() => assertChannelTransportCompatible(compatible)).not.toThrow();
  });

  it("rejects incompatible versions and unknown declarations", () => {
    expect(() =>
      assertChannelTransportCompatible({
        ...compatible,
        contractVersion: 2 as never,
      }),
    ).toThrow("does not support channel transport contract v1");
    expect(() =>
      assertChannelTransportCompatible({
        ...compatible,
        capabilities: new Set(["vendor-private-capability" as never]),
      }),
    ).toThrow("unknown capability");
    expect(() =>
      assertChannelTransportCompatible({
        ...compatible,
        capabilities: new Set(["multimodal-input"]),
        inputModalities: new Set(["image"]),
      }),
    ).toThrow("input capability declaration is inconsistent");
  });
});
