import { describe, expect, it } from "vitest";
import createAdapter from "../src/index.js";

describe("clean-room Adapter", () => {
  it("depends only on the public Adapter SDK at runtime", async () => {
    const root = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const source = await readFile(resolve(root, "src/index.ts"), "utf8");
    expect(Object.keys(manifest.dependencies)).toEqual([
      "@fyaic/wecom-adapter-sdk",
    ]);
    expect(source).not.toMatch(
      /runtime-contract|channel-core|transport-wecom|aibot-node-sdk/,
    );
  });

  it("preserves quoted text and image position through the public SDK helper", async () => {
    const adapter = await createAdapter({
      contractVersion: 1,
      config: {},
      tools: [],
      reportDiagnostic() {},
    });
    const events = [];
    for await (const event of adapter.run({
      message: {
        id: "message",
        accountId: "account",
        conversationId: "conversation",
        conversationType: "direct",
        senderId: "sender",
        receivedAt: "2000-01-01T00:00:00.000Z",
        quote: { parts: [{ type: "text", text: "earlier" }] },
        parts: [{ type: "image", path: "/protected/image.png" }],
      },
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({
      type: "message-completed",
      text: "echo: [Quoted message context] earlier [End quoted message context] [image]",
    });
  });
});
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
