import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createConfiguredAdapter } from "../apps/gateway/src/adapter-registry.js";
import type { AgentRuntimeAdapter } from "../packages/runtime-contract/src/index.js";

export class AgentCheckError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentCheckError";
  }
}

/** Two model turns, without a Bot connection or the production session store. */
export async function checkAgent(
  adapter: AgentRuntimeAdapter,
  options: { timeoutMs?: number; stopTimeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  if (
    ![timeoutMs, stopTimeoutMs].every(
      (value) => Number.isInteger(value) && value > 0,
    )
  )
    throw new AgentCheckError("invalid-check-timeout");
  let closed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ensureOpen = () => {
    if (closed) throw new AgentCheckError("agent-check-timeout");
  };
  const code = `CHECK_${randomBytes(6).toString("hex")}`;
  let sessionId: string | undefined;
  const started = performance.now();
  const turns: Array<{ deltaCount: number; elapsedMs: number }> = [];
  const work = async () => {
    await adapter.start?.();
    ensureOpen();
    if (!(await adapter.health()).ok)
      throw new AgentCheckError("agent-not-ready");
    ensureOpen();
    for (let index = 0; index < 2; index++) {
      const turnStarted = performance.now();
      const previousSession = sessionId;
      let text = "";
      let deltaCount = 0;
      let completed = false;
      for await (const event of adapter.run({
        sessionId,
        message: {
          id: `agent-check-${index}`,
          accountId: "local-check",
          conversationId: "local-check",
          conversationType: "direct",
          senderId: "local-check",
          receivedAt: new Date().toISOString(),
          parts: [
            {
              type: "text",
              text:
                index === 0
                  ? `This is a connectivity check. Do not use tools. Remember the code ${code} for my next message. Reply only READY.`
                  : "Do not use tools. Reply only with the exact code I asked you to remember in my previous message.",
            },
          ],
        },
      })) {
        ensureOpen();
        if (event.type === "session-started") sessionId = event.sessionId;
        if (event.type === "text-delta") {
          text += event.text;
          deltaCount++;
        }
        if (event.type === "message-completed") {
          completed = true;
          if (event.text !== undefined) text = event.text;
        }
        if (event.type === "failed") {
          // Classify upstream failures without exposing provider text or credentials.
          const category =
            /auth|login|credential|api.?key|unauthor|401|403/i.test(
              event.message,
            )
              ? "authentication"
              : /quota|rate.?limit|429|credit/i.test(event.message)
                ? "quota"
                : /timeout|timed out/i.test(event.message)
                  ? "timeout"
                  : "runtime";
          throw new AgentCheckError(`agent-turn-${category}`);
        }
      }
      if (
        !completed ||
        !sessionId ||
        text.trim() !== (index === 0 ? "READY" : code)
      )
        throw new AgentCheckError(
          index === 0
            ? "first-response-mismatch"
            : "conversation-continuity-failed",
        );
      if (index === 1 && sessionId !== previousSession)
        throw new AgentCheckError("conversation-session-changed");
      turns.push({
        deltaCount,
        elapsedMs: Math.round(performance.now() - turnStarted),
      });
    }
    return {
      event: "agent_check",
      ok: true,
      conversationContinuity: true,
      streamingObserved: turns.every((turn) => turn.deltaCount > 0),
      turns,
      elapsedMs: Math.round(performance.now() - started),
    };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          closed = true;
          reject(new AgentCheckError("agent-check-timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    closed = true;
    clearTimeout(timeout);
    let stopTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        adapter.stop?.(),
        new Promise<never>((_resolve, reject) => {
          stopTimeout = setTimeout(
            () => reject(new AgentCheckError("agent-stop-timeout")),
            stopTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(stopTimeout);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--help")) {
    console.log(
      "pnpm agent:check — checks the selected Agent with two real model turns. Uses its configured account/quota; never connects a WeCom Bot. Agent-owned test transcripts may remain. Echo deliberately fails the AI continuity check.",
    );
  } else {
    console.log(
      "Checking the configured Agent with two real model turns (uses your account/quota). No Bot connection.",
    );
    try {
      console.log(
        JSON.stringify(
          await checkAgent(
            await createConfiguredAdapter({ env: process.env, tools: [] }),
          ),
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent_check",
          ok: false,
          code:
            error instanceof AgentCheckError
              ? error.code
              : "adapter-start-or-configuration-failed",
        }),
      );
      console.error(
        "Agent check failed. Check installation, local login/provider and the selected Adapter settings in docs/getting-started.md. No Bot connection was opened.",
      );
      process.exitCode = 1;
    }
  }
}
