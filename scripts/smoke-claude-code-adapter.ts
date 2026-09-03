import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeRuntimeAdapter } from "../packages/adapter-claude-code/src/index.js";
import type {
  AgentRunEvent,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";

if (!process.argv.includes("--confirm-real-claude")) {
  throw new Error(
    "Refusing to call the real Claude service without --confirm-real-claude",
  );
}

const directory = await mkdtemp(join(tmpdir(), "wecom-claude-c1-smoke-"));
const adapter = new ClaudeCodeRuntimeAdapter({
  workingDirectory: directory,
  environment: safeSubprocessEnvironment(),
  settingSources: [],
});

try {
  const health = await adapter.health();
  if (!health.ok) throw new Error("Claude Code Adapter is unhealthy");

  const startedAt = performance.now();
  const first = await turn(
    message(
      "claude-c1-1",
      "请记住暗号 C1-SESSION-9D3，并且只回复 CLAUDE_C1_FIRST，不要使用工具或添加其他内容。",
    ),
  );
  if (!first.sessionId || first.text.trim() !== "CLAUDE_C1_FIRST") {
    throw new Error("Claude Code first turn did not match the smoke contract");
  }

  const resumed = await turn(
    message(
      "claude-c1-2",
      "上一轮让你记住的暗号是什么？只回复暗号，不要使用工具或添加其他内容。",
    ),
    first.sessionId,
  );
  if (resumed.text.trim() !== "C1-SESSION-9D3") {
    throw new Error(
      "Claude Code resumed turn did not match the smoke contract",
    );
  }

  const cancellation = await cancelTurn(
    message("claude-c1-cancel", "请缓慢写一篇很长的文章；不要使用任何工具。"),
  );
  if (!cancellation) {
    throw new Error(
      "Claude Code cancellation did not match the smoke contract",
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "claude_code_c1_smoke_completed",
      adapter: adapter.id,
      protocol: "official Claude Agent SDK",
      settings: "isolated",
      tools: "disabled",
      streaming: adapter.capabilities.has("streaming"),
      resume: adapter.capabilities.has("resume"),
      cancel: adapter.capabilities.has("cancel"),
      first: first.timings,
      resumed: resumed.timings,
      cancellation: "passed",
      totalMs: Math.round(performance.now() - startedAt),
    })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function turn(
  inbound: InboundMessage,
  sessionId?: string,
): Promise<{
  sessionId?: string;
  text: string;
  timings: { firstEventMs: number; firstTextMs: number; completedMs: number };
}> {
  const startedAt = performance.now();
  let firstEventMs: number | undefined;
  let firstTextMs: number | undefined;
  let activeSessionId = sessionId;
  let completedText: string | undefined;
  for await (const event of adapter.run({ message: inbound, sessionId })) {
    firstEventMs ??= Math.round(performance.now() - startedAt);
    if (event.type === "session-started") activeSessionId = event.sessionId;
    if (event.type === "text-delta") {
      firstTextMs ??= Math.round(performance.now() - startedAt);
    }
    if (event.type === "message-completed") completedText = event.text;
    if (event.type === "failed") throw new Error(event.message);
  }
  if (completedText === undefined || firstEventMs === undefined) {
    throw new Error("Claude Code turn did not complete");
  }
  return {
    sessionId: activeSessionId,
    text: completedText,
    timings: {
      firstEventMs,
      firstTextMs: firstTextMs ?? Math.round(performance.now() - startedAt),
      completedMs: Math.round(performance.now() - startedAt),
    },
  };
}

async function cancelTurn(inbound: InboundMessage): Promise<boolean> {
  const events: AgentRunEvent[] = [];
  let requested = false;
  for await (const event of adapter.run({ message: inbound })) {
    events.push(event);
    if (!requested && event.type === "session-started") {
      requested = true;
      await adapter.cancel(event.sessionId);
    }
  }
  return events.some(
    (event) =>
      event.type === "failed" &&
      event.message === "Claude Code request cancelled",
  );
}

function safeSubprocessEnvironment(): Record<string, string | undefined> {
  const names = ["HOME", "PATH", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries([
    ...names.map((name) => [name, process.env[name]]),
    ["CLAUDE_AGENT_SDK_CLIENT_APP", "wecom-agent-gateway/0.1.0"],
  ]);
}

function message(id: string, text: string): InboundMessage {
  return {
    id,
    accountId: "local-smoke",
    conversationId: "local-smoke",
    conversationType: "direct",
    senderId: "local-smoke",
    receivedAt: new Date().toISOString(),
    parts: [{ type: "text", text }],
  };
}
