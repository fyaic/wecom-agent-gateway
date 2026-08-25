import { describe, expect, it } from "vitest";
import { parseReplyActions } from "../src/reply-actions.js";

describe("reply action configuration", () => {
  it("parses bounded neutral action semantics without vendor JSON", () => {
    expect(
      parseReplyActions(
        JSON.stringify([
          {
            value: "请继续展开上一条回答",
            label: "继续展开",
            style: "primary",
          },
        ]),
      ),
    ).toEqual([
      {
        value: "请继续展开上一条回答",
        label: "继续展开",
        style: "primary",
      },
    ]);
    expect(parseReplyActions(undefined)).toBeUndefined();
  });

  it("rejects malformed actions before Gateway startup", () => {
    expect(() => parseReplyActions("{}")).toThrow("must be an array");
    expect(() => parseReplyActions('[{"label":"继续"}]')).toThrow(
      "requires value and label",
    );
    expect(() =>
      parseReplyActions('[{"value":"continue","label":"继续","style":"blue"}]'),
    ).toThrow("style is invalid");
  });
});
