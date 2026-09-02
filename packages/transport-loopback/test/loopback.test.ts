import { describe, expect, it, vi } from "vitest";
import type {
  ChannelEnterChatEvent,
  ChannelFeedbackEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";
import { LoopbackTransport } from "../src/index.js";

const message: InboundMessage = {
  id: "message",
  accountId: "account",
  conversationId: "conversation",
  conversationType: "group",
  senderId: "sender",
  receivedAt: "2000-01-01T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
};

describe("LoopbackTransport", () => {
  it("enforces lifecycle and preserves inbound/outbound envelopes", async () => {
    const transport = new LoopbackTransport({
      now: () => "2000-01-01T00:00:00.000Z",
    });
    await expect(transport.emitMessage(message)).rejects.toThrow("not started");
    await expect(transport.health()).resolves.toMatchObject({ ok: false });

    const onMessage = vi.fn(async () => undefined);
    const onFeedback = vi.fn(async () => undefined);
    const onEnterChat = vi.fn(async () => true);
    await transport.start(onMessage, onFeedback, onEnterChat);
    await expect(transport.health()).resolves.toMatchObject({ ok: true });
    await expect(
      transport.start(onMessage, onFeedback, onEnterChat),
    ).rejects.toThrow("already started");

    await transport.emitMessage(message);
    expect(onMessage).toHaveBeenCalledWith(message);

    const feedback: ChannelFeedbackEvent = {
      ...message,
      feedbackId: "feedback",
    };
    await transport.emitFeedback(feedback);
    expect(onFeedback).toHaveBeenCalledWith(feedback);

    const enterChat: ChannelEnterChatEvent = { ...message };
    await expect(transport.emitEnterChat(enterChat)).resolves.toBe(true);
    expect(onEnterChat).toHaveBeenCalledWith(enterChat);

    const command = {
      type: "proactive" as const,
      accountId: "account",
      conversationId: "conversation",
      text: "outbound",
    };
    await expect(transport.deliver(command)).resolves.toEqual({
      id: "loopback-delivery-1",
      acceptedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(transport.deliveries).toEqual([command]);

    await transport.stop();
    await transport.stop();
    await expect(transport.health()).resolves.toMatchObject({ ok: false });
    await expect(transport.deliver(command)).rejects.toThrow("not started");
  });
});
