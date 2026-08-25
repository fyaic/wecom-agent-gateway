import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRuntimeAdapter,
  parseRuntimeAdapterConfig,
  resolveRuntimeAdapterSpecifier,
} from "../src/index.js";

const fixtures = resolve(import.meta.dirname, "fixtures");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const gatewayPackage = resolve(repositoryRoot, "apps/gateway");

describe("external Adapter SDK", () => {
  it("loads and validates an explicit Adapter module", async () => {
    const diagnostics: string[] = [];
    const adapter = await loadRuntimeAdapter({
      moduleSpecifier: "./good-adapter.mjs",
      baseDirectory: fixtures,
      config: { id: "custom-kernel" },
      onDiagnostic: (_level, message) => diagnostics.push(message),
    });

    expect(adapter.id).toBe("custom-kernel");
    expect(adapter.contractVersion).toBe(1);
    expect(diagnostics).toEqual(["fixture loaded"]);
  });

  it("rejects incompatible modules and unsupported tool injection", async () => {
    await expect(
      loadRuntimeAdapter({
        moduleSpecifier: "./invalid-adapter.mjs",
        baseDirectory: fixtures,
      }),
    ).rejects.toThrow("runtime contract v1");

    await expect(
      loadRuntimeAdapter({
        moduleSpecifier: "./invalid-shape.mjs",
        baseDirectory: fixtures,
      }),
    ).rejects.toThrow("stable id");

    await expect(
      loadRuntimeAdapter({
        moduleSpecifier: "./good-adapter.mjs",
        baseDirectory: fixtures,
        tools: [
          {
            name: "read",
            description: "read",
            inputSchema: { type: "object" },
            effect: "read-only",
            approval: "never",
            async execute() {
              return { success: true, content: [] };
            },
          },
        ],
      }),
    ).rejects.toThrow("does not accept");
  });

  it("accepts bounded JSON config and safe path/package specifiers", () => {
    expect(parseRuntimeAdapterConfig('{"model":"demo","retries":2}')).toEqual({
      model: "demo",
      retries: 2,
    });
    expect(
      resolveRuntimeAdapterSpecifier(
        "@fyaic/wecom-adapter-sdk",
        repositoryRoot,
        gatewayPackage,
      ),
    ).toContain("/packages/adapter-sdk/src/index.ts");
    expect(
      resolveRuntimeAdapterSpecifier("./adapter.mjs", "/srv/gateway"),
    ).toBe("file:///srv/gateway/adapter.mjs");
    expect(() =>
      resolveRuntimeAdapterSpecifier("https://example.test/a.js"),
    ).toThrow("package name or local file path");
    expect(() => parseRuntimeAdapterConfig("[]")).toThrow("JSON object");
  });
});
