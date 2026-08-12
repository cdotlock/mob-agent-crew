import { describe, expect, it } from "vitest";
import {
  parseGitHubRepositoryUrl,
  parseMarkdownImport,
} from "../../src/imports/context-imports.js";

describe("workspace context imports", () => {
  it("normalizes a GitHub repository root", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/cdotlock/mob-agent-crew.git")).toEqual({
      url: "https://github.com/cdotlock/mob-agent-crew",
      owner: "cdotlock",
      repository: "mob-agent-crew",
      slug: "cdotlock/mob-agent-crew",
    });
  });

  it("rejects non-GitHub and nested URLs", () => {
    expect(() => parseGitHubRepositoryUrl("https://example.com/a/b")).toThrow();
    expect(() => parseGitHubRepositoryUrl("https://github.com/a/b/issues/1")).toThrow(
      "repository root",
    );
  });

  it("extracts a Markdown title and strips path components", () => {
    expect(parseMarkdownImport("../docs/plan.md", "\r\n# Launch plan\r\n\r\nShip it.\r\n")).toEqual({
      filename: "plan.md",
      title: "Launch plan",
      content: "# Launch plan\n\nShip it.",
      bytes: 23,
    });
  });

  it("rejects unsupported, empty, and oversized documents", () => {
    expect(() => parseMarkdownImport("plan.txt", "hello")).toThrow("Only .md");
    expect(() => parseMarkdownImport("plan.md", "   ")).toThrow("empty");
    expect(() => parseMarkdownImport("plan.md", "hello", 4)).toThrow("exceeds");
  });
});
