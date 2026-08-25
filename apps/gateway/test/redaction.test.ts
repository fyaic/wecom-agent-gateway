import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redactSecrets", () => {
  it("removes configured credentials and common secret fields", () => {
    expect(
      redactSecrets(
        "bot-secret-value authorization=Bearer-value token:abc123",
        ["bot-secret-value"],
      ),
    ).toBe("[REDACTED] authorization=[REDACTED] token=[REDACTED]");
  });
});
