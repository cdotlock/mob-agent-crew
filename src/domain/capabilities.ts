import { normalizeAgentEnvironment } from "./agent-composition.js";
import { DomainRuleError } from "./rules.js";

export type CapabilitySource = "builtin" | "workspace";
export type CapabilityKind = "skill" | "plugin" | "environment";
export type CapabilityRouteKind = "skills" | "plugins" | "environments";

interface CapabilityBase {
  id: string;
  name: string;
  description: string;
  source: CapabilitySource;
  updatedAt: string;
}

export interface SkillCapability extends CapabilityBase {
  kind: "skill";
  status: "available";
  instructions: string;
}

export interface PluginCapability extends CapabilityBase {
  kind: "plugin";
  status: "installed" | "unavailable";
  mode: "instructions-only";
  compatibleDrivers: string[];
  instructions: string;
}

export interface EnvironmentCapability extends CapabilityBase {
  kind: "environment";
  status: "available";
  values: Record<string, string>;
}

export type WorkspaceCapability = SkillCapability | PluginCapability | EnvironmentCapability;

export interface CapabilityCatalogView {
  version: 1;
  workspaceId: string;
  canonicalRoot: "capabilities";
  skills: Array<Omit<SkillCapability, "kind">>;
  plugins: Array<Omit<PluginCapability, "kind">>;
  environments: Array<Omit<EnvironmentCapability, "kind"> & { valueKeys: string[] }>;
}

export interface CapabilityUpsertInput {
  id: string;
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  status?: "available" | "installed" | "unavailable" | undefined;
  compatibleDrivers?: readonly string[] | undefined;
  values?: Readonly<Record<string, string>> | undefined;
}

const capabilityIdPattern = /^[a-z][a-z0-9+.-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/u;
const driverPattern = /^[a-z][a-z0-9-]{0,31}$/u;
const secretTextPatterns = [
  /\b(?:mob-|sk-)[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u,
  /\bBearer\s+\S+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:MOB_AI_KEY|MOB_RUN_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*=\s*\S+/iu,
] as const;

export function normalizeWorkspaceCapability(
  kind: CapabilityKind,
  input: CapabilityUpsertInput,
  options: { source?: CapabilitySource; updatedAt?: string } = {},
): WorkspaceCapability {
  const id = text(input.id, "capability id", 128);
  if (!capabilityIdPattern.test(id) || id.includes("..") || id.includes("//")) {
    throw new DomainRuleError(
      "invalid_capability_id",
      "Capability id must use a safe namespace:name form.",
    );
  }
  const name = sharedText(input.name, "capability name", 120);
  const description = sharedText(input.description, "capability description", 1_000);
  const source = options.source ?? "workspace";
  const updatedAt = normalizeTimestamp(options.updatedAt);

  if (kind === "skill") {
    return {
      kind,
      id,
      name,
      description,
      source,
      updatedAt,
      status: "available",
      instructions: sharedText(input.instructions, "skill instructions", 20_000),
    };
  }

  if (kind === "plugin") {
    const compatibleDrivers = normalizeDrivers(input.compatibleDrivers ?? []);
    const status = source === "builtin" && input.status === "installed" ? "installed" : "unavailable";
    if (status === "installed" && compatibleDrivers.length === 0) {
      throw new DomainRuleError(
        "invalid_plugin_compatibility",
        "An installed instructions-only plugin must declare at least one compatible harness.",
      );
    }
    return {
      kind,
      id,
      name,
      description,
      source,
      updatedAt,
      status,
      mode: "instructions-only",
      compatibleDrivers,
      instructions: sharedText(input.instructions, "plugin instructions", 20_000),
    };
  }

  const environment = normalizeAgentEnvironment({ reference: id, values: input.values ?? {} });
  return {
    kind,
    id,
    name,
    description,
    source,
    updatedAt,
    status: "available",
    values: { ...environment.values },
  };
}

export function routeCapabilityKind(kind: CapabilityRouteKind): CapabilityKind {
  if (kind === "skills") return "skill";
  if (kind === "plugins") return "plugin";
  return "environment";
}

function normalizeDrivers(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) {
    throw new DomainRuleError("invalid_plugin_compatibility", "A plugin supports at most 32 harnesses.");
  }
  const drivers = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string" || !driverPattern.test(raw.trim())) {
      throw new DomainRuleError("invalid_plugin_compatibility", "Plugin harness ids are invalid.");
    }
    drivers.add(raw.trim());
  }
  return [...drivers].sort();
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new DomainRuleError("invalid_capability", `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /\0/u.test(normalized)) {
    throw new DomainRuleError("invalid_capability", `${label} is invalid.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  return text(value, label, max);
}

function sharedText(value: unknown, label: string, max: number): string {
  const normalized = optionalText(value, label, max);
  if (secretTextPatterns.some((pattern) => pattern.test(normalized))) {
    throw new DomainRuleError(
      "secret_capability_text_forbidden",
      `${label} appears to contain a credential and cannot be shared.`,
    );
  }
  return normalized;
}

function normalizeTimestamp(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainRuleError("invalid_capability", "Capability timestamp is invalid.");
  }
  return parsed.toISOString();
}
