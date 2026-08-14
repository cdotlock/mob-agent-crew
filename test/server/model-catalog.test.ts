import { describe, expect, it, vi } from "vitest";
import { ModelCatalogService } from "../../src/server/model-catalog.js";

describe("MobAI model catalog", () => {
  it("merges configured metadata with the official endpoint and caches the result", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer internal-test-token");
      return new Response(JSON.stringify({
        data: [
          { id: "deepseek-v4-pro", owned_by: "mob-ai", protocols: ["openai"] },
          { id: "another-router-model", owned_by: "mob-ai" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const service = new ModelCatalogService({
      endpoint: "https://ai.example.test/api/v1/models",
      authorizationToken: "internal-test-token",
      configuredJson: JSON.stringify({
        models: [{
          id: "another-router-model",
          displayName: "Another Model",
          protocols: ["anthropic-messages"],
          capabilities: { tools: true },
        }],
      }),
      fetch,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    });

    const first = await service.get();
    const second = await service.get();

    expect(fetch).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(first).toMatchObject({ version: 1, source: "merged", stale: false });
    expect(first.models).toEqual([
      expect.objectContaining({
        id: "another-router-model",
        name: "Another Model",
        protocols: ["openai-chat", "anthropic-messages"],
        capabilities: { tools: true },
      }),
      expect.objectContaining({ id: "deepseek-v4-pro", protocols: ["openai-chat"] }),
    ]);
    expect(JSON.stringify(first)).not.toContain("internal-test-token");
  });

  it("returns stable fallback metadata when the remote catalog is unavailable", async () => {
    const service = new ModelCatalogService({
      endpoint: "https://ai.example.test/api/v1/models",
      fetch: vi.fn(async () => { throw new Error("network detail must stay private"); }),
      fallbackModels: [{
        id: "configured-default",
        name: "configured-default",
        provider: "MobAI",
        protocols: ["openai-chat"],
        contextWindow: null,
        capabilities: {},
      }],
    });

    await expect(service.get()).resolves.toMatchObject({
      source: "fallback",
      stale: true,
      warnings: ["model_catalog_remote_unavailable"],
      models: [expect.objectContaining({ id: "configured-default" })],
    });
  });
});
