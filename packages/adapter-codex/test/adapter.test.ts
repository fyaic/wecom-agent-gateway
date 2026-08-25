import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { exerciseTextRuntimeContract } from "@fyaic/wecom-runtime-contract/testkit";
import { CodexRuntimeAdapter } from "../src/index.js";

const inbound: InboundMessage = {
  id: "m1",
  accountId: "bot",
  conversationId: "chat",
  conversationType: "direct",
  senderId: "user",
  receivedAt: "2026-08-20T00:00:00.000Z",
  parts: [{ type: "text", text: "hello" }],
};

describe("CodexRuntimeAdapter", () => {
  it("passes the shared text, streaming, and resume contract", async () => {
    const responses: ThreadEvent[][] = [
      textTurn("thread-contract", "codex-turn-1", true),
      textTurn("thread-contract", "codex-turn-2", false),
    ];
    const adapter = new CodexRuntimeAdapter({
      client: {
        startThread: () => contractThread(responses.shift() ?? []),
        resumeThread: () => contractThread(responses.shift() ?? []),
      },
    });

    const transcript = await exerciseTextRuntimeContract(adapter, inbound);
    expect(transcript.first).toContainEqual({
      type: "message-completed",
      text: "codex-turn-1",
    });
    expect(transcript.resumed).toContainEqual({
      type: "message-completed",
      text: "codex-turn-2",
    });
  });

  it("converts Codex text snapshots into true deltas and records the thread", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "error", message: "Reconnecting... 1/5" },
      {
        type: "item.updated",
        item: { id: "a1", type: "agent_message", text: "你" },
      },
      {
        type: "item.updated",
        item: { id: "a1", type: "agent_message", text: "你好" },
      },
      {
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "你好" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ];
    const adapter = new CodexRuntimeAdapter({
      client: {
        startThread: () => ({
          id: null,
          runStreamed: async () => ({ events: asAsync(events) }),
        }),
        resumeThread: () => {
          throw new Error("unexpected resume");
        },
      },
    });

    const actual = [];
    for await (const event of adapter.run({ message: inbound }))
      actual.push(event);

    expect(actual).toEqual([
      { type: "session-started", sessionId: "thread-1" },
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      { type: "message-completed", text: "你好" },
    ]);
  });

  it("passes latency-oriented thread options to new and resumed sessions", async () => {
    const options: unknown[] = [];
    const thread = {
      id: "thread",
      runStreamed: async () => ({
        events: asAsync([
          {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          },
        ] satisfies ThreadEvent[]),
      }),
    };
    const adapter = new CodexRuntimeAdapter({
      workingDirectory: "/workspace",
      modelReasoningEffort: "low",
      client: {
        startThread: (value) => {
          options.push(value);
          return thread;
        },
        resumeThread: (_id, value) => {
          options.push(value);
          return thread;
        },
      },
    });
    for await (const _event of adapter.run({ message: inbound })) void _event;
    for await (const _event of adapter.run({
      message: inbound,
      sessionId: "thread",
    }))
      void _event;
    expect(options).toEqual([
      {
        workingDirectory: "/workspace",
        model: undefined,
        modelReasoningEffort: "low",
      },
      {
        workingDirectory: "/workspace",
        model: undefined,
        modelReasoningEffort: "low",
      },
    ]);
  });
});

async function* asAsync(events: ThreadEvent[]): AsyncIterable<ThreadEvent> {
  yield* events;
}

function contractThread(events: ThreadEvent[]) {
  return {
    id: "thread-contract",
    runStreamed: async () => ({ events: asAsync(events) }),
  };
}

function textTurn(
  threadId: string,
  text: string,
  started: boolean,
): ThreadEvent[] {
  return [
    ...(started
      ? ([
          { type: "thread.started", thread_id: threadId },
        ] satisfies ThreadEvent[])
      : []),
    {
      type: "item.updated",
      item: { id: `item-${text}`, type: "agent_message", text },
    },
    {
      type: "item.completed",
      item: { id: `item-${text}`, type: "agent_message", text },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ];
}
