import { describe, expect, it } from "vitest";
import { buildApiUrl, normalizeServerUrl } from "../../src/client/url.js";

describe("Mob client URLs", () => {
  it("normalizes HTTP servers and preserves a deployment base path", () => {
    expect(normalizeServerUrl("https://mob.example.test/crew/")).toBe(
      "https://mob.example.test/crew",
    );
    expect(buildApiUrl("https://mob.example.test/crew", "/api/tasks/task 1")).toBe(
      "https://mob.example.test/crew/api/tasks/task%201",
    );
  });

  it("combines inline and typed query parameters", () => {
    expect(
      buildApiUrl("http://127.0.0.1:4310", "api/messages?cursor=old", {
        cursor: "new value",
        limit: 20,
        active: true,
        ignored: undefined,
      }),
    ).toBe("http://127.0.0.1:4310/api/messages?cursor=new+value&limit=20&active=true");
  });

  it.each([
    "https://evil.example/api",
    "//evil.example/api",
    "../admin",
    "%2e%2e/admin",
    "%252e%252e/admin",
    "api/%2fadmin",
    "api\\admin",
    "api/tasks#secret",
  ])("rejects unsafe API paths: %s", (path) => {
    expect(() => buildApiUrl("https://mob.example.test/base", path)).toThrow("Unsafe API path");
  });

  it.each([
    "file:///tmp/mob.sock",
    "https://user:password@mob.example.test",
    "https://mob.example.test/path?token=secret",
    "https://mob.example.test/path#fragment",
  ])("rejects unsafe server URLs: %s", (server) => {
    expect(() => normalizeServerUrl(server)).toThrow("Invalid Mob server URL");
  });
});
