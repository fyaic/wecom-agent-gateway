import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  ChannelCapability,
  ChannelTransport,
} from "@fyaic/wecom-runtime-contract";
import { LoopbackTransport } from "@fyaic/transport-loopback";
import { runTransportConformance } from "../src/index.js";

describe("Transport Conformance", () => {
  it("certifies the vendor-neutral loopback Transport", async () => {
    const transport = new LoopbackTransport({
      now: () => "2000-01-01T00:00:00.000Z",
    });
    const report = await runTransportConformance(transport, transport);
    const evidence = JSON.parse(
      await readFile(
        new URL(
          "../../../docs/evidence/transport-conformance-loopback.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(report).toEqual(evidence);
    expect(report.summary).toEqual({ passed: 22, failed: 0, skipped: 0 });
  });

  it("fails closed on inconsistent capability declarations", async () => {
    const transport = new LoopbackTransport();
    Object.defineProperty(transport, "capabilities", {
      value: new Set<ChannelCapability>(["multimodal-input"]),
    });
    Object.defineProperty(transport, "inputModalities", {
      value: new Set(["image"]),
    });

    const report = await runTransportConformance(transport, transport);
    expect(report.passed).toBe(false);
    expect(report.checks).toEqual([
      {
        id: "transport.compatibility",
        status: "failed",
        code: "inconsistent-input-capabilities",
      },
    ]);
  });

  it("never includes unexpected upstream errors in its report", async () => {
    const transport = new LoopbackTransport();
    const driver = {
      deliveries: transport.deliveries,
      emitMessage: async () => {
        throw new Error("sensitive upstream response");
      },
      emitFeedback: transport.emitFeedback.bind(transport),
      emitEnterChat: transport.emitEnterChat.bind(transport),
    };

    const report = await runTransportConformance(
      transport as ChannelTransport,
      driver,
    );
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain("sensitive upstream");
    expect(report.checks).toContainEqual({
      id: "inbound.direct",
      status: "failed",
      code: "unexpected-conformance-error",
    });
  });
});
