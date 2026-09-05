import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStarterConfig, setup } from "./setup.js";
import { runDemo } from "./demo.js";
import { checkAgent } from "./check-agent.js";
import type { AgentRuntimeAdapter } from "../packages/runtime-contract/src/index.js";
import { diagnoseGatewayEnvironment } from "../apps/gateway/src/doctor.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("first-run experience", () => {
  it("bounds a stalled upstream and stops it without exposing provider data", async () => {
    const stop = vi.fn(async () => undefined);
    const adapter: AgentRuntimeAdapter = {
      id: "fixture",
      contractVersion: 1,
      capabilities: new Set(),
      health: () => new Promise(() => undefined),
      async *run() {
        throw new Error("should not run");
      },
      stop,
    };
    await expect(checkAgent(adapter, { timeoutMs: 5 })).rejects.toThrow(
      "agent-check-timeout",
    );
    expect(stop).toHaveBeenCalledOnce();
    adapter.health = async () => ({ ok: true });
    adapter.run = async function* () {
      yield { type: "failed", message: "401 invalid API key private-fixture" };
    };
    await expect(checkAgent(adapter)).rejects.toThrow(
      "agent-turn-authentication",
    );
  });
  it("checks semantic continuity through the actual session, not a repeated code in the second prompt", async () => {
    let code = "";
    let stopped = false;
    const adapter: AgentRuntimeAdapter = {
      id: "fixture",
      contractVersion: 1,
      capabilities: new Set(["streaming", "resume"]),
      async health() {
        return { ok: true };
      },
      async stop() {
        stopped = true;
      },
      async *run(request) {
        const text = request.message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (!request.sessionId) {
          code = text.match(/CHECK_[a-f0-9]+/)![0];
          yield { type: "session-started", sessionId: "fixture-session" };
          yield { type: "text-delta", text: "READY" };
          yield { type: "message-completed", text: "READY" };
        } else {
          expect(request.sessionId).toBe("fixture-session");
          expect(text).not.toContain(code);
          yield { type: "text-delta", text: code };
          yield { type: "message-completed", text: code };
        }
      },
    };
    expect(await checkAgent(adapter)).toMatchObject({
      ok: true,
      conversationContinuity: true,
      streamingObserved: true,
    });
    expect(stopped).toBe(true);
    adapter.run = async function* () {
      yield { type: "message-completed", text: "wrong" };
    };
    await expect(checkAgent(adapter)).rejects.toThrow(
      "first-response-mismatch",
    );
  });
  it("exercises the offline Core/SQLite/external Adapter path with six assertions", async () => {
    const lines: string[] = [];
    await runDemo((line) => lines.push(line));
    expect(lines.filter((line) => line.startsWith("✓"))).toHaveLength(6);
  });

  it("creates private minimal config and never overwrites an existing .env", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wecom-starter-test-"));
    directories.push(directory);
    await setup(["--adapter", "echo"], directory);
    const envPath = join(directory, ".env");
    const original = await readFile(envPath, "utf8");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(parseEnv(original).GATEWAY_ADAPTER).toBe("external");
    await expect(setup(["--adapter", "codex"], directory)).rejects.toThrow(
      "kept unchanged",
    );
    expect(await readFile(envPath, "utf8")).toBe(original);
  });

  it("refuses a dangling .env symlink instead of following it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wecom-starter-link-"));
    directories.push(directory);
    const target = join(directory, "not-created");
    await symlink(target, join(directory, ".env"));
    await expect(setup(["--adapter", "pi"], directory)).rejects.toThrow(
      "kept unchanged",
    );
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips workspace paths and gives every real profile a Doctor-compatible selection", async () => {
    for (const profile of ["codex", "kimi", "pi", "openclaw"] as const) {
      const env = parseEnv(
        createStarterConfig(profile, '/tmp/agent "project"'),
      );
      expect(env.AGENT_WORKING_DIRECTORY).toBe('/tmp/agent "project"');
      const checks = await diagnoseGatewayEnvironment(env);
      expect(
        checks.find((item) => item.name === "adapter-selection")?.status,
      ).toBe("ok");
      expect(
        checks.find((item) => item.name === "wecom-bot-credentials")?.status,
      ).toBe("error");
      expect(
        checks.find((item) => item.name === "wecom-allowlist")?.status,
      ).toBe("error");
      if (profile === "openclaw")
        expect(env).toHaveProperty("OPENCLAW_GATEWAY_TOKEN", "");
    }
    expect(() => createStarterConfig("pi", "unsafe\npath")).toThrow();
  });
});
