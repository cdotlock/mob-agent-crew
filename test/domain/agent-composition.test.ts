import { describe, expect, it } from "vitest";
import {
  evaluateAgentModelCompatibility,
  normalizeAgentComposition,
} from "../../src/domain/agent-composition.js";
import type { ModelCatalogEntry } from "../../src/domain/model.js";

describe("Agent composition", () => {
  it("normalizes the thin model, skills and environment selections", () => {
    expect(normalizeAgentComposition({
      modelId: " deepseek-v4-pro ",
      skillRefs: ["repo:review", "repo:review", "workspace:typescript"],
      environment: {
        reference: "workspace:railway-small",
        values: { NODE_ENV: "development", LOG_LEVEL: "info" },
      },
    })).toEqual({
      modelId: "deepseek-v4-pro",
      skillRefs: ["repo:review", "workspace:typescript"],
      environment: {
        reference: "workspace:railway-small",
        values: { NODE_ENV: "development", LOG_LEVEL: "info" },
      },
    });
  });

  it.each([
    { environment: { values: { API_KEY: "plain" } }, code: "secret_environment_key_forbidden" },
    { environment: { values: { MOB_AI_KEY: "plain" } }, code: "secret_environment_key_forbidden" },
    { environment: { values: { THIRD_PARTY_KEY: "plain" } }, code: "secret_environment_key_forbidden" },
    { environment: { values: { DATABASE_URL: "postgres://localhost/example" } }, code: "secret_environment_key_forbidden" },
    { environment: { values: { SERVICE_URL: "https://user:password@example.test" } }, code: "secret_environment_value_forbidden" },
    { environment: { values: { ENDPOINT_ALIAS: "mob-sensitive-value" } }, code: "secret_environment_value_forbidden" },
    { environment: { reference: "https://example.test/env?token=value" }, code: "invalid_environment_reference" },
  ])("never persists secret-shaped environment input", ({ environment, code }) => {
    expect(() => normalizeAgentComposition({ environment })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("exposes a protocol compatibility hook without owning either runtime", () => {
    const openAiModel: ModelCatalogEntry = {
      id: "router-model",
      name: "Router Model",
      provider: "MobAI",
      protocols: ["openai-chat"],
      contextWindow: null,
      capabilities: {},
    };

    expect(evaluateAgentModelCompatibility("pi", openAiModel, true)).toMatchObject({
      compatible: true,
      status: "compatible",
    });
    expect(evaluateAgentModelCompatibility("claude", openAiModel, true)).toMatchObject({
      compatible: false,
      status: "incompatible",
    });
    expect(evaluateAgentModelCompatibility("future-harness", openAiModel, true)).toMatchObject({
      compatible: null,
      status: "unknown-driver",
    });
  });
});
