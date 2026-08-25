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
