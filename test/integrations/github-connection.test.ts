import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubConnectionStatus,
  isGitHubCliConfigured,
} from "../../src/integrations/github-connection.js";

describe("GitHub CLI connection status", () => {
  it("requires a non-empty token or real non-empty token file", async () => {
    expect(isGitHubCliConfigured({ GH_TOKEN: "" })).toBe(false);
    expect(isGitHubCliConfigured({ GH_TOKEN_FILE: "/missing/github-token" })).toBe(false);

    const directory = await mkdtemp(join(tmpdir(), "mob-github-status-"));
    try {
      const tokenFile = join(directory, "github-token");
      await writeFile(tokenFile, "", { mode: 0o600 });
      expect(isGitHubCliConfigured({ GH_TOKEN_FILE: tokenFile })).toBe(false);
      await writeFile(tokenFile, "opaque-token", { mode: 0o600 });
      expect(isGitHubCliConfigured({ GH_TOKEN_FILE: tokenFile })).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns only a boolean and safe stdin/status commands", () => {
    const secret = "never-return-this-github-token";
    const status = githubConnectionStatus(isGitHubCliConfigured({ GH_TOKEN: secret }));

    expect(status).toEqual({
      configured: true,
      variable: "GH_TOKEN",
      setup: {
        railway: "railway variable set GH_TOKEN --stdin --skip-deploys",
        verify: "gh auth status --hostname github.com",
        note: expect.stringContaining("standard input"),
      },
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});
