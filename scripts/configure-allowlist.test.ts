import { describe, expect, it } from "vitest";
import {
  getEnvValue,
  parseAuthorizedHumanId,
  resolveGroupConversationId,
  setEnvValue,
} from "./configure-allowlist.js";

describe("configure allowlist", () => {
  it("extracts only the authorized human identity", () => {
    const context = `机器人身份：\n名字：Bot\nID：bot-id\n授权真人用户身份：\n名字：Owner\nID：human-id\n`;
    expect(parseAuthorizedHumanId(context)).toBe("human-id");
  });

  it("resolves one exact group match", () => {
    expect(
      resolveGroupConversationId(
        {
          sessions: [
            { chat_id: "direct", chat_name: "目标群", chat_type: "single" },
            { chat_id: "group", chat_name: "目标群", chat_type: "group" },
          ],
        },
        "目标群",
      ),
    ).toBe("group");
  });

  it("rejects ambiguous exact group matches", () => {
    expect(() =>
      resolveGroupConversationId(
        {
          sessions: [
            { chat_id: "one", chat_name: "目标群", chat_type: "group" },
            { chat_id: "two", chat_name: "目标群", chat_type: "group" },
          ],
        },
        "目标群",
      ),
    ).toThrow("不唯一");
  });

  it("updates environment values without duplicating keys", () => {
    const result = setEnvValue("A=1\nB=2\n", "B", "x,y");
    expect(result).toBe('A=1\nB="x,y"\n');
  });

  it("reads quoted and unquoted environment values", () => {
    expect(getEnvValue('A="x,y"\nB=plain\n', "A")).toBe("x,y");
    expect(getEnvValue('A="x,y"\nB=plain\n', "B")).toBe("plain");
  });
});
