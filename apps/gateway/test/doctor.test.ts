import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "../src/adapter-registry.js";
import { diagnoseGatewayEnvironment } from "../src/doctor.js";

describe("gateway doctor", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["unhealthy", "throws"])(
    "does not disclose Adapter identity, health detail or exceptions: %s",
    async (mode) => {
      const stop = vi.fn(async () => undefined);
      const probe = vi.spyOn(registry, "createConfiguredAdapter");
      if (mode === "throws")
        probe.mockRejectedValue(new Error("private-token"));
      else
        probe.mockResolvedValue({
          id: "private-identity",
          health: async () => ({ ok: false, detail: "private-token" }),
          stop,
        } as unknown as Awaited<
          ReturnType<typeof registry.createConfiguredAdapter>
        >);
      const checks = await diagnoseGatewayEnvironment(
        {
          PATH: process.env.PATH,
          WECOM_BOT_ID: "set",
          WECOM_BOT_SECRET: "set",
          WECOM_ALLOWED_DIRECT_SENDERS: "set",
          GATEWAY_ADAPTER: "pi",
          PI_EXECUTABLE: process.execPath,
        },
        { live: true },
      );
      expect(probe).toHaveBeenCalledOnce();
      expect(checks).toContainEqual(
        expect.objectContaining({
          name: "adapter-live-health",
          status: "error",
        }),
      );
      expect(JSON.stringify(checks)).not.toContain("private-");
      if (mode === "unhealthy") expect(stop).toHaveBeenCalledOnce();
    },
  );
  it("reports a complete OpenClaw loopback configuration without exposing values", async () => {
    const checks = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "private-bot-id",
      WECOM_BOT_SECRET: "private-bot-secret",
      WECOM_ALLOWED_DIRECT_SENDERS: "private-sender-id",
      GATEWAY_ADAPTER: "openclaw",
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_TOKEN: "private-openclaw-token",
    });

    expect(checks.every((item) => item.status === "ok")).toBe(true);
    const output = JSON.stringify(checks);
    expect(output).not.toContain("private-bot-id");
    expect(output).not.toContain("private-bot-secret");
    expect(output).not.toContain("private-sender-id");
    expect(output).not.toContain("private-openclaw-token");
  });

  it("fails closed for missing allowlists and remote OpenClaw URLs", async () => {
    const checks = await diagnoseGatewayEnvironment({
      WECOM_BOT_ID: "set",
      WECOM_BOT_SECRET: "set",
      GATEWAY_ADAPTER: "openclaw",
      OPENCLAW_GATEWAY_URL: "wss://gateway.example.com",
      OPENCLAW_GATEWAY_TOKEN: "set",
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "wecom-allowlist", status: "error" }),
        expect.objectContaining({
          name: "openclaw-gateway-url",
          status: "error",
        }),
      ]),
    );
  });

  it("checks the configured Pi executable", async () => {
    const checks = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "set",
      WECOM_BOT_SECRET: "set",
      WECOM_ALLOWED_DIRECT_SENDERS: "set",
      GATEWAY_ADAPTER: "pi",
      PI_EXECUTABLE: process.execPath,
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "adapter-selection", status: "ok" }),
        expect.objectContaining({ name: "pi-executable", status: "ok" }),
      ]),
    );
  });

  it("validates local control aliases without exposing target identities", async () => {
    const checks = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "private-bot-id",
      WECOM_BOT_SECRET: "private-bot-secret",
      WECOM_ALLOWED_DIRECT_SENDERS: "private-direct-id",
      GATEWAY_ADAPTER: "pi",
      PI_EXECUTABLE: process.execPath,
      GATEWAY_CONTROL_ENABLED: "true",
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "local-control-targets",
          status: "ok",
        }),
      ]),
    );
    expect(JSON.stringify(checks)).not.toContain("private-direct-id");

    const rejected = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "set",
      WECOM_BOT_SECRET: "set",
      WECOM_ALLOWED_DIRECT_SENDERS: "allowed",
      GATEWAY_ADAPTER: "pi",
      PI_EXECUTABLE: process.execPath,
      GATEWAY_CONTROL_ENABLED: "true",
      GATEWAY_PROACTIVE_TARGETS_JSON: JSON.stringify({
        other: { conversationType: "direct", conversationId: "not-allowed" },
      }),
    });
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "local-control-targets",
          status: "error",
        }),
      ]),
    );
  });

  it("validates external Adapter selection without exposing its configuration", async () => {
    const checks = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "set",
      WECOM_BOT_SECRET: "set",
      WECOM_ALLOWED_DIRECT_SENDERS: "set",
      GATEWAY_ADAPTER: "external",
      GATEWAY_EXTERNAL_ADAPTER_MODULE:
        "./examples/adapter-template/src/index.ts",
      GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON: '{"privateValue":"do-not-print"}',
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "external-adapter-config",
          status: "ok",
        }),
      ]),
    );
    expect(JSON.stringify(checks)).not.toContain("do-not-print");
  });

  it("requires operational endpoints to remain on loopback", async () => {
    const checks = await diagnoseGatewayEnvironment({
      PATH: process.env.PATH,
      WECOM_BOT_ID: "set",
      WECOM_BOT_SECRET: "set",
      WECOM_ALLOWED_DIRECT_SENDERS: "set",
      GATEWAY_ADAPTER: "pi",
      PI_EXECUTABLE: process.execPath,
      GATEWAY_OBSERVABILITY_ENABLED: "true",
      GATEWAY_OBSERVABILITY_HOST: "0.0.0.0",
      GATEWAY_OBSERVABILITY_PORT: "9464",
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability-loopback",
          status: "error",
        }),
        expect.objectContaining({ name: "observability-port", status: "ok" }),
      ]),
    );
  });
});
