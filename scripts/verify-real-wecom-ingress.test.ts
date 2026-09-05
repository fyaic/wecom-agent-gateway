import { describe, expect, it } from "vitest";
import type {
  InboundMessage,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";
import {
  evaluateRealIngress,
  parseRealIngressArgs,
  type RealIngressCandidate,
} from "./verify-real-wecom-ingress.js";

describe("real ingress CLI evidence scope", () => {
  it("requires an explicit session compatibility ID instead of inferring a deployment alias", () => {
    const args = ["--kind=text", "--conversation=direct"];
    expect(() => parseRealIngressArgs(args)).toThrow(
      "session compatibility id",
    );
    expect(() => parseRealIngressArgs([...args, "--adapter= "])).toThrow(
      "session compatibility id",
    );
    expect(
      parseRealIngressArgs([...args, "--adapter=fixture:protocol-v1"]).adapter,
    ).toBe("fixture:protocol-v1");
  });
});

function candidate(message: InboundMessage): RealIngressCandidate {
  return {
    message,
    deliveries: [
      {
        status: "delivered",
        command: {
          type: "reply",
          accountId: "account",
          conversationId: "conversation",
          replyReference: { requestId: "opaque" },
          streamId: "stream",
          text: "done",
          final: true,
        } satisfies OutboundCommand,
      },
    ],
    acceptedReceipts: 1,
    deliveryErrors: 0,
    adapterSessionPresent: true,
  };
}

describe("real WeCom ingress evidence", () => {
  it("certifies one marker-scoped plain-text turn", () => {
    const evidence = evaluateRealIngress({
      kind: "text",
      conversationType: "direct",
      mediaSpoolEmpty: true,
      candidates: [
        candidate({
          id: "message",
          accountId: "account",
          conversationId: "conversation",
          conversationType: "direct",
          senderId: "sender",
          receivedAt: new Date().toISOString(),
          parts: [{ type: "text", text: "current turn" }],
          replyReference: { requestId: "opaque" },
          metadata: { msgtype: "text" },
        }),
      ],
    });

    expect(evidence.passed).toBe(true);
    expect(evidence.checks.expectedQuoteShape).toBe(true);
  });

  it("certifies a privacy-safe real quoted-text record", () => {
    const evidence = evaluateRealIngress({
      kind: "quote-text",
      conversationType: "direct",
      expectedQuoteText: "prior answer",
      mediaSpoolEmpty: true,
      candidates: [
        candidate({
          id: "message",
          accountId: "account",
          conversationId: "conversation",
          conversationType: "direct",
          senderId: "sender",
          receivedAt: new Date().toISOString(),
          parts: [{ type: "text", text: "current turn" }],
          quote: { parts: [{ type: "text", text: "prior answer" }] },
          replyReference: { requestId: "opaque" },
        }),
      ],
    });

    expect(evidence.passed).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("prior answer");
    expect(JSON.stringify(evidence)).not.toContain("opaque");
  });

  it("rejects native video evidence that was wire-classified as a file", () => {
    const evidence = evaluateRealIngress({
      kind: "native-video",
      conversationType: "direct",
      mediaSpoolEmpty: true,
      candidates: [
        candidate({
          id: "message",
          accountId: "account",
          conversationId: "conversation",
          conversationType: "direct",
          senderId: "sender",
          receivedAt: new Date().toISOString(),
          parts: [{ type: "video", mimeType: "video/mp4" }],
          replyReference: { requestId: "opaque" },
          metadata: { msgtype: "file" },
        }),
      ],
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.expectedWireShape).toBe(false);
  });

  it("requires the native video capability boundary response", () => {
    const video = candidate({
      id: "message",
      accountId: "account",
      conversationId: "conversation",
      conversationType: "direct",
      senderId: "sender",
      receivedAt: new Date().toISOString(),
      parts: [{ type: "video", mimeType: "video/mp4" }],
      replyReference: { requestId: "opaque" },
      metadata: { msgtype: "video" },
    });
    video.deliveries[0] = {
      ...video.deliveries[0]!,
      command: {
        ...video.deliveries[0]!.command,
        text: "当前 Agent 不支持视频输入。",
      } as OutboundCommand,
    };
    video.adapterSessionPresent = false;
    const evidence = evaluateRealIngress({
      kind: "native-video",
      conversationType: "direct",
      mediaSpoolEmpty: true,
      candidates: [video],
    });

    expect(evidence.passed).toBe(true);
    expect(evidence.checks.adapterBoundarySatisfied).toBe(true);
  });

  it("fails closed when the marker matches more than one inbound", () => {
    const message: InboundMessage = {
      id: "message",
      accountId: "account",
      conversationId: "conversation",
      conversationType: "group",
      senderId: "sender",
      receivedAt: new Date().toISOString(),
      parts: [{ type: "text", text: "marker" }],
      quote: { parts: [{ type: "image", mimeType: "image/png" }] },
      replyReference: { requestId: "opaque" },
    };
    const evidence = evaluateRealIngress({
      kind: "quote-media",
      conversationType: "group",
      expectedQuoteMedia: "image",
      mediaSpoolEmpty: true,
      candidates: [candidate(message), candidate({ ...message, id: "second" })],
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.exactlyOneInbound).toBe(false);
  });
});
