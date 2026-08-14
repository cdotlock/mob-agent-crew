import type {
  AgentEnvironment,
  ModelCatalogEntry,
  ModelProtocol,
} from "./model.js";
import { DomainRuleError } from "./rules.js";

export const DEFAULT_AGENT_ENVIRONMENT: AgentEnvironment = Object.freeze({
  reference: null,
  values: Object.freeze({}),
});

const referencePattern = /^[a-z][a-z0-9+.-]*:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/u;
const modelOrSkillPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const environmentKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const forbiddenEnvironmentKey = /(?:^|_)(?:API_?KEY|KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|DATABASE|DB|DSN|PASS(?:WORD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/iu;
const secretValuePatterns = [
  /^(?:bearer|basic)\s+/iu,
  /^(?:mob-|sk-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA)/u,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/iu,
] as const;

export interface AgentCompositionInput {
  modelId?: string | null | undefined;
  skillRefs?: readonly string[] | undefined;
  environment?: AgentEnvironmentInput | null | undefined;
}

export interface AgentEnvironmentInput {
  reference?: string | null | undefined;
  values?: Readonly<Record<string, string>> | undefined;
}

export interface NormalizedAgentComposition {
  modelId: string | null;
  skillRefs: string[];
  environment: AgentEnvironment;
}

export function normalizeAgentComposition(
  input: AgentCompositionInput = {},
): NormalizedAgentComposition {
  const modelId = normalizeOptionalReference(input.modelId, "modelId");
  const skillRefs = normalizeSkillRefs(input.skillRefs ?? []);
  const environment = normalizeAgentEnvironment(input.environment);
  return { modelId, skillRefs, environment };
}

export function normalizeAgentEnvironment(
  input: AgentEnvironmentInput | null | undefined,
): AgentEnvironment {
  if (input === null || input === undefined) return DEFAULT_AGENT_ENVIRONMENT;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new DomainRuleError(
      "invalid_agent_environment",
      "Environment must contain a secret-free reference and/or safe values.",
    );
  }

  const reference = input.reference === undefined || input.reference === null
    ? null
    : input.reference.trim();
  if (reference !== null && (
    !referencePattern.test(reference) ||
    reference.includes("..") ||
    reference.includes("//")
  )) {
    throw new DomainRuleError(
      "invalid_environment_reference",
      "Environment reference must use a safe namespace:name form.",
    );
  }

  const values = input.values ?? {};
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new DomainRuleError("invalid_agent_environment", "Environment values must be an object.");
  }
  const entries = Object.entries(values);
  if (entries.length > 32) {
    throw new DomainRuleError("agent_environment_too_large", "Environment supports at most 32 safe values.");
  }
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!environmentKeyPattern.test(key) || forbiddenEnvironmentKey.test(key)) {
      throw new DomainRuleError(
        "secret_environment_key_forbidden",
        `Environment key '${key}' is unsafe or reserved for runtime secrets. Use an environment reference instead.`,
      );
    }
    if (typeof rawValue !== "string") {
      throw new DomainRuleError("invalid_environment_value", `Environment value '${key}' must be a string.`);
    }
    const value = rawValue.trim();
    if (
      value.length > 256 ||
      /[\r\n\0]/u.test(value) ||
      secretValuePatterns.some((pattern) => pattern.test(value))
    ) {
      throw new DomainRuleError(
        "secret_environment_value_forbidden",
        `Environment value '${key}' looks sensitive. Store it in the referenced runtime environment instead.`,
      );
    }
    normalized[key] = value;
  }
  return { reference, values: normalized };
}

function normalizeSkillRefs(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) {
    throw new DomainRuleError("invalid_skill_refs", "An Agent supports at most 32 skill references.");
  }
  const unique = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") {
      throw new DomainRuleError("invalid_skill_ref", "Skill references must be strings.");
    }
    const value = rawValue.trim();
    if (!modelOrSkillPattern.test(value)) {
      throw new DomainRuleError("invalid_skill_ref", `Skill reference '${value}' is invalid.`);
    }
    unique.add(value);
  }
  return [...unique];
}

function normalizeOptionalReference(
  rawValue: string | null | undefined,
  field: string,
): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  const value = rawValue.trim();
  if (!modelOrSkillPattern.test(value)) {
    throw new DomainRuleError("invalid_agent_composition", `${field} is invalid.`);
  }
  return value;
}

const driverProtocols: Readonly<Record<string, readonly ModelProtocol[]>> = Object.freeze({
  pi: ["openai-chat"],
  omp: ["openai-chat"],
  hermes: ["openai-chat"],
  deepseek: ["openai-chat"],
  claude: ["anthropic-messages"],
  codex: ["openai-responses"],
});

export type AgentModelCompatibilityStatus =
  | "uses-default"
  | "unknown-driver"
  | "unknown-model-protocol"
  | "compatible"
  | "incompatible";

export interface AgentModelCompatibility {
  compatible: boolean | null;
  status: AgentModelCompatibilityStatus;
  driverProtocols: readonly ModelProtocol[];
  modelProtocols: readonly ModelProtocol[];
}

/**
 * A replaceable compatibility hook. It validates wiring metadata only; it
 * never owns a harness or model implementation.
 */
export function evaluateAgentModelCompatibility(
  driver: string,
  model: ModelCatalogEntry | null,
  modelSelected: boolean,
  protocolResolver: (driverId: string) => readonly ModelProtocol[] = defaultDriverModelProtocols,
): AgentModelCompatibility {
  const supported = protocolResolver(driver);
  if (!modelSelected) {
    return { compatible: true, status: "uses-default", driverProtocols: supported, modelProtocols: [] };
  }
  if (supported.length === 0) {
    return { compatible: null, status: "unknown-driver", driverProtocols: [], modelProtocols: model?.protocols ?? [] };
  }
  if (!model || model.protocols.length === 0) {
    return { compatible: null, status: "unknown-model-protocol", driverProtocols: supported, modelProtocols: model?.protocols ?? [] };
  }
  const compatible = model.protocols.some((protocol) => supported.includes(protocol));
  return {
    compatible,
    status: compatible ? "compatible" : "incompatible",
    driverProtocols: supported,
    modelProtocols: model.protocols,
  };
}

export function assertAgentModelCompatible(
  driver: string,
  model: ModelCatalogEntry | null,
  modelSelected: boolean,
): AgentModelCompatibility {
  const result = evaluateAgentModelCompatibility(driver, model, modelSelected);
  if (result.compatible === false) {
    throw new DomainRuleError(
      "agent_model_protocol_mismatch",
      `Harness '${driver}' and model '${model?.id ?? "unknown"}' do not share a supported protocol.`,
    );
  }
  return result;
}

export function defaultDriverModelProtocols(driver: string): readonly ModelProtocol[] {
  return driverProtocols[driver] ?? [];
}
