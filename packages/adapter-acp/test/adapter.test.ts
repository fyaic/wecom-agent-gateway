import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import {
  exerciseReplyActionRuntimeContract,
  exerciseTextRuntimeContract,
} from "@fyaic/wecom-runtime-contract/testkit";
import {
  AcpRuntimeAdapter,
  type AcpRuntimeAdapterOptions,
} from "../src/index.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.ts",
);
const lifecycleFixture = join(dirname(fixture), "lifecycle-acp-agent.ts");

const adapters = new Set<AcpRuntimeAdapter>();
const directories = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  // Hooks also run when a test times out during start(), before its finally.
  await Promise.all([...adapters].map((adapter) => adapter.stop()));
  adapters.clear();
  await Promise.all(
    [...directories].map((path) => rm(path, { recursive: true, force: true })),
  );
  directories.clear();
});

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
    try {
      await adapter.start();
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
      expect(adapter.capabilities.has("interaction-resume")).toBe(true);
      expect(adapter.capabilities.has("reply-actions")).toBe(true);
      expect(adapter.capabilities.has("multimodal-input")).toBe(true);
      expect(adapter.capabilities.has("quoted-context")).toBe(true);
      expect(adapter.inputModalities).toEqual(new Set(["image"]));
    } finally {
      await adapter.stop();
    }
  });

  it("passes quoted context through ACP content blocks", async () => {
    const adapter = createAdapter();
    try {
      await adapter.start();
      const events = await collect(
        adapter.run({
          message: {
            ...inbound,
            quote: { parts: [{ type: "text", text: "earlier" }] },
            parts: [{ type: "text", text: "current" }],
          },
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "message-completed",
        text: "quote:received",
      });
    } finally {
      await adapter.stop();
    }
  });

  it("continues a reply action in the loaded ACP session exactly once", async () => {
    const adapter = createAdapter();
    try {
      await adapter.start();
      const session = await exerciseTextRuntimeContract(adapter, {
        ...inbound,
        id: "reply-action-session",
      });
      const transcript = await exerciseReplyActionRuntimeContract(
        adapter,
        {
          ...inbound,
          id: "reply-action",
          parts: [{ type: "text", text: "continue" }],
        },
        session.sessionId,
      );
      expect(transcript.resumed.at(-1)).toMatchObject({
        type: "message-completed",
      });
    } finally {
      await adapter.stop();
    }
  });

  it("maps ACP image input and delegates permission to the Gateway callback", async () => {
    const adapter = createAdapter();
    try {
      await adapter.start();
      const directory = await mkdtemp(join(tmpdir(), "wecom-acp-test-"));
      directories.add(directory);
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

  it("bounds stalled initialization and reaps a child that ignores SIGTERM", async () => {
    // Advance only our deadlines after the child reports readiness. A short
    // wall-clock startup deadline would measure host CPU load, not this fault.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pid: number | undefined;
    let ready!: () => void;
    const childReady = new Promise<void>((resolveReady) => {
      ready = resolveReady;
    });
    const adapter = createAdapter({
      args: [
        "-e",
        `
        process.on('SIGTERM', () => {});
        process.stdin.resume();
        setInterval(() => {}, 1000);
        process.stderr.write(String(process.pid) + '\\n');
      `,
      ],
      startupTimeoutMs: 500,
      onStderr: (line) => {
        pid = Number(line);
        ready();
      },
    });
    const failedStartup = expect(adapter.start()).rejects.toThrow(
      "ACP initialization timed out",
    );
    await childReady;
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    await failedStartup;
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(await adapter.health()).toEqual({
      ok: false,
      detail: "ACP initialization timed out",
    });
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it("cleans up rejected initialization and permits a subsequent start", async () => {
    const args = [lifecycleFixture, "--reject-initialize"];
    let pid: number | undefined;
    const adapter = createAdapter({
      args,
      onStderr: (line) => {
        if (line.startsWith("pid:")) pid = Number(line.slice(4));
      },
    });
    await expect(adapter.start()).rejects.toThrow("initialization rejected");
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
    args.pop();
    await adapter.start();
    expect((await adapter.health()).ok).toBe(true);
  });

  it("fails startup if the executable cannot be spawned or exits before initialization", async () => {
    const missing = createAdapter({
      executable: join(tmpdir(), "wecom-acp-missing-executable", "agent"),
    });
    await expect(missing.start()).rejects.toThrow();
    expect((await missing.health()).ok).toBe(false);
    const exited = createAdapter({ args: ["-e", "process.exit(23)"] });
    await expect(exited.start()).rejects.toThrow();
    expect((await exited.health()).ok).toBe(false);
  });

  it("drains verbose stderr without requiring a logging callback", async () => {
    const adapter = createAdapter({ args: [fixture, "--verbose"] });
    await adapter.start();
    const events = await collect(adapter.run({ message: inbound }));
    expect(events.at(-1)).toMatchObject({
      type: "message-completed",
      text: "acp-turn-1",
    });
  });
});

function createAdapter(
  overrides: Partial<AcpRuntimeAdapterOptions> = {},
): AcpRuntimeAdapter {
  const adapter = new AcpRuntimeAdapter({
    id: "fake-acp",
    executable: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: process.env,
    ...overrides,
  });
  adapters.add(adapter);
  return adapter;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
