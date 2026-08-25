import { describe, expect, it } from "vitest";
import {
  createConfiguredAdapter,
  safeAgentEnvironment,
  safePiEnvironment,
} from "../src/adapter-registry.js";
import { PooledPiRuntimeAdapter } from "@fyaic/pi-runtime-adapter";

describe("adapter registry", () => {
  it("keeps Codex as the compatibility default and selects Kimi through ACP", async () => {
    const codex = await createConfiguredAdapter({ env: {}, tools: [] });
    const kimi = await createConfiguredAdapter({
      env: {
        GATEWAY_ADAPTER: "kimi",
        KIMI_EXECUTABLE: "/opt/kimi",
        KIMI_WORKING_DIRECTORY: "/workspace",
      },
      tools: [],
    });
    expect(codex.id).toBe("codex-app-server");
    expect(kimi.id).toBe("kimi");
    expect(codex.contractVersion).toBe(1);
    expect(kimi.contractVersion).toBe(1);
    expect(kimi.sessionCompatibilityId).toBe("kimi:acp-v1");
  });

  it("supports any ACP executable with explicit identity and argv", async () => {
    const adapter = await createConfiguredAdapter({
      env: {
        GATEWAY_ADAPTER: "acp",
        ACP_ADAPTER_ID: "pi",
        ACP_EXECUTABLE: "/opt/pi-acp",
        ACP_ARGS_JSON: '["--stdio"]',
        ACP_WORKING_DIRECTORY: "/workspace",
      },
      tools: [],
    });
    expect(adapter.id).toBe("pi");
    expect(adapter.contractVersion).toBe(1);
    expect(adapter.sessionCompatibilityId).toBe("pi:acp-v1");
  });

  it("selects OpenClaw through its independent Gateway protocol", async () => {
    const adapter = await createConfiguredAdapter({
      env: {
        GATEWAY_ADAPTER: "openclaw",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_TOKEN: "test-token",
      },
      tools: [],
    });
    expect(adapter.id).toBe("openclaw");
    expect(adapter.contractVersion).toBe(1);
    expect(adapter.sessionCompatibilityId).toBe("openclaw:gateway-ws-v4");
  });

  it("selects Pi through its official JSONL RPC protocol", async () => {
    const adapter = await createConfiguredAdapter({
      env: {
        GATEWAY_ADAPTER: "pi",
        PI_EXECUTABLE: "/opt/pi",
        PI_ARGS_JSON: '["--provider","zai"]',
        PI_WORKING_DIRECTORY: "/workspace",
      },
      tools: [],
    });
    expect(adapter.id).toBe("pi");
    expect(adapter.contractVersion).toBe(1);
    expect(adapter.sessionCompatibilityId).toBe("pi:rpc-v1");
    expect(adapter).toBeInstanceOf(PooledPiRuntimeAdapter);
    expect((adapter as PooledPiRuntimeAdapter).maxWorkers).toBe(2);
  });

  it("does not pass Bot credentials or unrelated Gateway config to ACP agents", () => {
    const env = safeAgentEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      KIMI_PROFILE: "default",
      WECOM_BOT_SECRET: "must-not-pass",
      GATEWAY_DATABASE_PATH: "/private/gateway.db",
      CUSTOM_PROVIDER_TOKEN: "allowed-explicitly",
      ACP_AGENT_ENV_ALLOWLIST: "CUSTOM_PROVIDER_TOKEN",
    });
    expect(env).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      KIMI_PROFILE: "default",
      CUSTOM_PROVIDER_TOKEN: "allowed-explicitly",
    });
  });

  it("passes only explicit provider variables to Pi", () => {
    const env = safePiEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      ZAI_API_KEY: "allowed-explicitly",
      PI_AGENT_ENV_ALLOWLIST: "ZAI_API_KEY",
      WECOM_BOT_SECRET: "must-not-pass",
      GATEWAY_DATABASE_PATH: "/private/gateway.db",
    });
    expect(env).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      ZAI_API_KEY: "allowed-explicitly",
    });
  });

  it("rejects unknown adapters and malformed ACP argv", async () => {
    await expect(
      createConfiguredAdapter({
        env: { GATEWAY_ADAPTER: "unknown" },
        tools: [],
      }),
    ).rejects.toThrow("Invalid GATEWAY_ADAPTER");
    await expect(
      createConfiguredAdapter({
        env: {
          GATEWAY_ADAPTER: "acp",
          ACP_ADAPTER_ID: "pi",
          ACP_EXECUTABLE: "/opt/pi-acp",
          ACP_ARGS_JSON: "--stdio",
        },
        tools: [],
      }),
    ).rejects.toThrow("ACP_ARGS_JSON must be a JSON string array");
    await expect(
      createConfiguredAdapter({
        env: { GATEWAY_ADAPTER: "pi", PI_ARGS_JSON: "--model glm" },
        tools: [],
      }),
    ).rejects.toThrow("PI_ARGS_JSON must be a JSON string array");
  });

  it("fails closed instead of silently dropping an ACP runtime tool catalog", async () => {
    const tool = {
      name: "read",
      description: "read",
      inputSchema: { type: "object" },
      effect: "read-only" as const,
      approval: "never" as const,
      execute: async () => ({ success: true, content: [] }),
    };
    await expect(
      createConfiguredAdapter({
        env: { GATEWAY_ADAPTER: "kimi" },
        tools: [tool],
      }),
    ).rejects.toThrow("Runtime tool catalog is not supported");
  });

  it("loads an external Adapter module without a registry code change", async () => {
    const adapter = await createConfiguredAdapter({
      env: {
        GATEWAY_ADAPTER: "external",
        GATEWAY_EXTERNAL_ADAPTER_MODULE:
          "./examples/adapter-template/src/index.ts",
        GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON: '{"prefix":"external: "}',
      },
      tools: [],
    });
    expect(adapter.id).toBe("example");
    expect(adapter.contractVersion).toBe(1);
    expect(adapter.sessionCompatibilityId).toBe("example:v1");
  });
});
