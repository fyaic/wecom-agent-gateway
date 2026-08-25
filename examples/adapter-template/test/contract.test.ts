import { describe, expect, it } from "vitest";
import { exerciseTextRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";
import createAdapter from "../src/index.js";

describe("external Adapter template", () => {
  it("satisfies the shared text/session contract", async () => {
    const adapter = await createAdapter({
      contractVersion: 1,
      config: { prefix: "demo: " },
      tools: [],
      reportDiagnostic() {},
    });
    const transcript = await exerciseTextRuntimeContract(adapter, {
      id: "message-1",
      accountId: "account",
      conversationId: "conversation",
      conversationType: "direct",
      senderId: "sender",
      receivedAt: "2026-08-24T00:00:00.000Z",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(transcript.first).toContainEqual({
      type: "message-completed",
      text: "demo: hello",
    });
  });
});
