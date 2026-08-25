import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { exerciseTextRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";
import { AcpRuntimeAdapter } from "../src/index.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.ts",
);

const inbound: InboundMessage = {
  id: "m-acp",
  accountId: "bot",
  conversationId: "chat",
  conversationType: "direct",
  senderId: "user",
  receivedAt: "2026-08-24T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
};

describe("AcpRuntimeAdapter", () => {
  it("passes the shared text, streaming, and resume contract", async () => {
    const adapter = createAdapter();
    await adapter.start();
    try {
      const transcript = await exerciseTextRuntimeContract(adapter, inbound);
      expect(transcript.first).toContainEqual({
        type: "message-completed",
        text: "acp-turn-1",
      });
      expect(transcript.resumed).toContainEqual({
        type: "message-completed",
        text: "acp-turn-2",
      });
      expect(adapter.capabilities).toEqual(
        expect.objectContaining({ has: expect.any(Function) }),
      );
      expect(adapter.capabilities.has("resume")).toBe(true);
      expect(adapter.capabilities.has("multimodal-input")).toBe(true);
      expect(adapter.inputModalities).toEqual(new Set(["image"]));
    } finally {
      await adapter.stop();
    }
  });

  it("maps ACP image input and delegates permission to the Gateway callback", async () => {
    const adapter = createAdapter();
    await adapter.start();
    try {
      const directory = await mkdtemp(join(tmpdir(), "wecom-acp-test-"));
      const imagePath = join(directory, "pixel.png");
      await writeFile(imagePath, Buffer.from("fake-image"));
      const imageEvents = await collect(
        adapter.run({
          message: {
            ...inbound,
            id: "m-image",
            parts: [
              {
                type: "image",
                path: imagePath,
                mimeType: "image/png",
              },
            ],
          },
        }),
      );
      expect(imageEvents).toContainEqual({
        type: "message-completed",
        text: "image:received",
      });

      const approvals: unknown[] = [];
      const permissionEvents = await collect(
        adapter.run({
          message: {
            ...inbound,
            id: "m-permission",
            parts: [{ type: "text", text: "permission" }],
          },
          requestApproval: async (request) => {
            approvals.push(request);
            return "approved";
          },
        }),
      );
      expect(approvals).toEqual([
        {
          toolName: "fake.write",
          effect: "write",
          summary: "Write a deterministic test artifact",
        },
      ]);
      expect(permissionEvents).toContainEqual({
        type: "message-completed",
        text: "permission:allow",
      });
    } finally {
      await adapter.stop();
    }
  });
});

function createAdapter(): AcpRuntimeAdapter {
  return new AcpRuntimeAdapter({
    id: "fake-acp",
    executable: process.execPath,
    args: ["--import", "tsx", fixture],
    cwd: process.cwd(),
    env: process.env,
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
