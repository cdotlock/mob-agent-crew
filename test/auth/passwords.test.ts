import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/passwords.js";

describe("password credentials", () => {
  it("hashes and verifies without storing the password", async () => {
    const password = "correct horse battery staple";
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("rejects short passwords and malformed hashes", async () => {
    await expect(hashPassword("too-short")).rejects.toThrow("at least 12 characters");
    await expect(verifyPassword("anything", "broken")).resolves.toBe(false);
  });
});
