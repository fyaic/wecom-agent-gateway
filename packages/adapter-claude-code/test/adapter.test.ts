import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { exerciseTextRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";
import {
  ClaudeCodeRuntimeAdapter,
  type ClaudeCodeQueryFactory,
  type ClaudeCodeQueryParameters,
} from "../src/index.js";

const inbound: InboundMessage = {
  id: "message-1",
  accountId: "bot",
  conversationId: "conversation",
  conversationType: "direct",
  senderId: "sender",
  receivedAt: "2026-09-02T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
};

describe("ClaudeCodeRuntimeAdapter", () => {
  it("loads the pinned official SDK without creating a model turn", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    expect(sdk.query).toBeTypeOf("function");
    expect(sdk.startup).toBeTypeOf("function");
    await expect(
      new ClaudeCodeRuntimeAdapter().health(),
    ).resolves.toMatchObject({ ok: true });
  });

  it("maps init, partial text, final result, and resume", async () => {
    const calls: ClaudeCodeQueryParameters[] = [];
    const adapter = new ClaudeCodeRuntimeAdapter({
      workingDirectory: "/workspace",
      model: "claude-test",
      environment: { PATH: "/bin", ANTHROPIC_API_KEY: "test-only" },
      queryFactory: fakeTextFactory(calls, ["first reply", "second reply"]),
    });

    const transcript = await exerciseTextRuntimeContract(adapter, inbound);

    expect(transcript.sessionId).toBe("session-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      prompt: "hello",
      options: {
        abortController: expect.any(AbortController),
        cwd: "/workspace",
        env: { PATH: "/bin", ANTHROPIC_API_KEY: "test-only" },
        includePartialMessages: true,
        forwardSubagentText: false,
        model: "claude-test",
        permissionMode: "dontAsk",
        resume: undefined,
        settingSources: [],
        tools: [],
      },
    });
    expect(calls[1]?.options.resume).toBe("session-1");
  });

  it("preserves quoted text and ignores subagent deltas", async () => {
    let prompt = "";
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: (parameters) => {
        prompt = parameters.prompt;
        return messages([
          init("session-quote"),
          delta("not forwarded", "tool-use-1"),
          delta("ok"),
          success("session-quote", "ok"),
        ]);
      },
    });

    const actual = await collect(
      adapter.run({
        message: {
          ...inbound,
          quote: { parts: [{ type: "text", text: "earlier" }] },
          parts: [{ type: "text", text: "current" }],
        },
      }),
    );

    expect(prompt).toBe(
      "[Quoted message context]\nearlier\n[End quoted message context]\ncurrent",
    );
    expect(actual).toContainEqual({ type: "text-delta", text: "ok" });
    expect(actual).not.toContainEqual({
      type: "text-delta",
      text: "not forwarded",
    });
  });

  it("rejects unsupported media before invoking Claude", async () => {
    let invoked = false;
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: () => {
        invoked = true;
        return messages([]);
      },
    });

    const actual = await collect(
      adapter.run({
        message: {
          ...inbound,
          parts: [{ type: "image", path: "/fixture/image.png" }],
        },
      }),
    );

    expect(invoked).toBe(false);
    expect(actual).toEqual([
      {
        type: "failed",
        message: "Claude Code Adapter currently accepts text input only",
      },
    ]);
  });

  it("does not inherit the Gateway process environment by default", async () => {
    let subprocessEnvironment: Record<string, string | undefined> | undefined;
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: (parameters) => {
        subprocessEnvironment = parameters.options.env;
        return messages([
          init("session-isolated"),
          delta("ok"),
          success("session-isolated", "ok"),
        ]);
      },
    });

    await collect(adapter.run({ message: inbound }));
    expect(subprocessEnvironment).toEqual({
      CLAUDE_AGENT_SDK_CLIENT_APP: "wecom-agent-gateway/0.1.0",
    });
  });

  it("rejects host secrets and session credentials from the subprocess", () => {
    for (const name of [
      "WECOM_BOT_SECRET",
      "GATEWAY_CONTROL_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(
        () =>
          new ClaudeCodeRuntimeAdapter({
            environment: { [name]: "not-a-real-secret" },
          }),
      ).toThrow("forbidden host or session credential");
    }

    expect(
      () =>
        new ClaudeCodeRuntimeAdapter({
          environment: { ANTHROPIC_API_KEY: "test-only" },
        }),
    ).not.toThrow();
  });

  it("fails closed when streamed text differs from the final result", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: () =>
        messages([
          init("session-mismatch"),
          delta("partial"),
          success("session-mismatch", "different"),
        ]),
    });

    const actual = await collect(adapter.run({ message: inbound }));
    expect(actual.at(-1)).toEqual({
      type: "failed",
      message: "Claude Code stream did not match its final result",
    });
    expect(actual.some((event) => event.type === "message-completed")).toBe(
      false,
    );
  });

  it("maps SDK result errors without forwarding upstream error text", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: () =>
        messages([
          init("session-error"),
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["secret-bearing upstream diagnostic"],
            session_id: "session-error",
          },
        ]),
    });

    const actual = await collect(adapter.run({ message: inbound }));
    expect(actual.at(-1)).toEqual({
      type: "failed",
      message: "Claude Code request failed",
    });
    expect(JSON.stringify(actual)).not.toContain("secret-bearing");
  });

  it("aborts the active SDK query and makes repeated cancel safe", async () => {
    let parameters: ClaudeCodeQueryParameters | undefined;
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: (value) => {
        parameters = value;
        return cancellableMessages(value);
      },
    });

    const events: unknown[] = [];
    const running = (async () => {
      for await (const event of adapter.run({ message: inbound })) {
        events.push(event);
        if (event.type === "session-started") {
          await adapter.cancel?.(event.sessionId);
          await adapter.cancel?.(event.sessionId);
        }
      }
    })();

    await running;
    expect(parameters?.options.abortController.signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "failed",
      message: "Claude Code request cancelled",
    });
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "message-completed",
      ),
    ).toBe(false);
  });

  it("rejects a different session returned by resume", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      queryFactory: () =>
        messages([init("unexpected-session"), delta("ignored")]),
    });

    const actual = await collect(
      adapter.run({ message: inbound, sessionId: "expected-session" }),
    );
    expect(actual).toEqual([
      {
        type: "failed",
        message: "Claude Code resumed a different session",
      },
    ]);
  });
});

function fakeTextFactory(
  calls: ClaudeCodeQueryParameters[],
  replies: string[],
): ClaudeCodeQueryFactory {
  return (parameters) => {
    calls.push(parameters);
    const text = replies.shift() ?? "fallback";
    return messages([
      init("session-1"),
      delta(text.slice(0, 3)),
      delta(text.slice(3)),
      success("session-1", text),
    ]);
  };
}

async function* messages(values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function* cancellableMessages(
  parameters: ClaudeCodeQueryParameters,
): AsyncIterable<unknown> {
  yield init("session-cancel");
  if (parameters.options.abortController.signal.aborted) {
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  }
  yield delta("should not happen");
  yield success("session-cancel", "should not happen");
}

function init(sessionId: string): unknown {
  return { type: "system", subtype: "init", session_id: sessionId };
}

function delta(text: string, parentToolUseId: string | null = null): unknown {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
}

function success(sessionId: string, text: string): unknown {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
