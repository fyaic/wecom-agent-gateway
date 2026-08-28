import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redactSecrets", () => {
  it("removes configured credentials and common secret fields", () => {
    expect(
      redactSecrets(
        "bot-secret-value authorization=Bearer-value token:abc123 api_key=key123 password:pass123 credential=cred123",
        ["bot-secret-value"],
      ),
    ).toBe(
      "[REDACTED] authorization=[REDACTED] token=[REDACTED] api_key=[REDACTED] password=[REDACTED] credential=[REDACTED]",
    );
  });
});
