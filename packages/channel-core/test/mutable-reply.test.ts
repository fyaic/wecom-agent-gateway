import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentReplyProjection,
  MutableReply,
  type ReplyUpdate,
} from "../src/index.js";

afterEach(() => vi.useRealTimers());

describe("MutableReply", () => {
  it("acknowledges immediately, coalesces deltas, and finalizes one message", async () => {
    vi.useFakeTimers();
    const updates: ReplyUpdate[] = [];
    const reply = new MutableReply(async (update) => {
      updates.push(update);
    });

    await reply.open();
    reply.update("你");
    reply.update("你好");
    expect(updates).toEqual([
      { text: "⏳ 已收到，等待 Agent 响应…", final: false },
    ]);

    await vi.advanceTimersByTimeAsync(250);
    expect(updates.at(-1)).toEqual({ text: "你好", final: false });

    reply.update("你好！");
    await reply.close("你好！");
    await vi.runAllTimersAsync();
    expect(updates).toEqual([
      { text: "⏳ 已收到，等待 Agent 响应…", final: false },
      { text: "你好", final: false },
      { text: "你好！", final: true },
    ]);
  });

  it("keeps one mutable progress presentation on coalesced partials", async () => {
    vi.useFakeTimers();
    const updates: ReplyUpdate[] = [];
    const initialPresentation = {
      kind: "notice" as const,
      id: "progress_1",
      title: "⏳ 请求已接收",
    };
    const thinkingPresentation = {
      ...initialPresentation,
      title: "🤔 Agent 正在思考…",
    };
    const reply = new MutableReply(
      async (update) => {
        updates.push(update);
      },
      { initialPresentation },
    );

    await reply.open();
    reply.update("🤔 Agent 正在思考…", thinkingPresentation);
    reply.update("结论");
    await vi.advanceTimersByTimeAsync(250);
    await reply.close("结论");

    expect(updates).toEqual([
      {
        text: "⏳ 已收到，等待 Agent 响应…",
        final: false,
        presentation: initialPresentation,
      },
      { text: "结论", final: false, presentation: thinkingPresentation },
      { text: "结论", final: true },
    ]);
  });

  it("replaces an in-stream progress card without creating a new message", async () => {
    vi.useFakeTimers();
    const updates: ReplyUpdate[] = [];
    const reply = new MutableReply(
      async (update) => {
        updates.push(update);
      },
      {
        initialPresentation: {
          kind: "notice",
          id: "progress_2",
          title: "🤔 Agent 正在思考…",
        },
      },
    );

    await reply.open();
    reply.update("正在处理");
    await vi.advanceTimersByTimeAsync(250);
    reply.replacePresentation({
      kind: "actions",
      id: "run_control_2",
      title: "⏳ 任务仍在执行",
      actions: [{ id: "cancel", label: "停止任务", style: "danger" }],
    });
    await vi.advanceTimersByTimeAsync(250);
    await reply.close("处理完成");

    expect(updates.at(-2)).toMatchObject({
      text: "正在处理",
      final: false,
      presentation: { kind: "actions", id: "run_control_2" },
    });
    expect(updates.at(-1)).toEqual({ text: "处理完成", final: true });
  });
});

describe("AgentReplyProjection", () => {
  it("renders only status explicitly emitted by the Agent", () => {
    const projection = new AgentReplyProjection();
    expect(
      projection.apply({
        type: "status",
        phase: "thinking",
        emoji: "🧐",
        text: "正在核对资料…",
      }),
    ).toBe("🧐 正在核对资料…");
    expect(projection.apply({ type: "text-delta", text: "结论" })).toBe("结论");
    expect(
      projection.apply({
        type: "status",
        phase: "tool-running",
        emoji: "🔎",
        text: "正在搜索",
      }),
    ).toBe("结论\n\n🔎 正在搜索");
    expect(projection.completed()).toBe("结论");
  });
});
