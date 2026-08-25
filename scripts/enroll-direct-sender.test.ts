import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { isEnrollmentMessage } from "./enroll-direct-sender.js";

const message = (conversationType: "direct" | "group", text: string) =>
  ({
    id: "message",
    accountId: "bot",
    conversationId: "conversation",
    conversationType,
    senderId: "sender",
    receivedAt: "2026-08-20T00:00:00.000Z",
    parts: [{ type: "text", text }],
  }) satisfies InboundMessage;

describe("direct sender enrollment", () => {
  it("accepts only an exact token from a direct chat", () => {
    expect(isEnrollmentMessage(message("direct", "TOKEN"), "TOKEN")).toBe(true);
    expect(isEnrollmentMessage(message("group", "TOKEN"), "TOKEN")).toBe(false);
    expect(isEnrollmentMessage(message("direct", "OTHER"), "TOKEN")).toBe(
      false,
    );
  });
});
