import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "../../src/security/redaction.js";

describe("runtime secret redaction", () => {
  it("removes explicit and common process credentials from text", () => {
    const secret = "mob-examplecredential1234567890";
    expect(redactText(`MOB_AI_KEY=${secret} Bearer token-value sk-examplecredential1234567890`, [secret]))
      .toBe("MOB_AI_KEY=[REDACTED] Bearer [REDACTED] [REDACTED]");
  });

  it("redacts nested event payloads without changing their shape", () => {
    expect(redactValue({ output: ["MOB_RUN_TOKEN=run-token", { key: "safe" }] }))
      .toEqual({ output: ["MOB_RUN_TOKEN=[REDACTED]", { key: "safe" }] });
  });
});
