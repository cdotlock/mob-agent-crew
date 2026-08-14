import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normalizeAgentEnvironment } from "../domain/agent-composition.js";
import {
  type CapabilityCatalogView,
  type CapabilityKind,
  type CapabilityUpsertInput,
  type EnvironmentCapability,
  type PluginCapability,
  type SkillCapability,
  type WorkspaceCapability,
  normalizeWorkspaceCapability,
} from "../domain/capabilities.js";
import { DomainRuleError } from "../domain/rules.js";

const CATALOG_SCHEMA_VERSION = 1;
const BUILTIN_UPDATED_AT = "2026-08-14T00:00:00.000Z";
const capabilityDirectories: Readonly<Record<CapabilityKind, string>> = Object.freeze({
  skill: "skills",
  plugin: "plugins",
  environment: "environments",
});

interface StoredCapability {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  entity: "capability";
  data: WorkspaceCapability;
}

export interface CapabilityCatalogOptions {
  workspaceRoot: (workspaceId: string) => string;
  deepseekPluginInstalled?: boolean;
}

export interface AgentCapabilitySelection {
  driver: string;
  skillRefs: readonly string[];
  pluginRefs: readonly string[];
  environment: {
    reference: string | null;
    values: Readonly<Record<string, string>>;
  };
}

export interface ResolvedAgentCapabilities {
  skills: SkillCapability[];
  plugins: PluginCapability[];
  environment: EnvironmentCapability | null;
  environmentValues: Record<string, string>;
  promptContext: string;
  warnings: string[];
}

/**
 * A file-native catalog for context and safe runtime composition. It does not
 * install or execute harnesses, models, plugins, commands, or arbitrary paths.
 */
export class CapabilityCatalogService {
  readonly #options: CapabilityCatalogOptions;

  constructor(options: CapabilityCatalogOptions) {
    this.#options = options;
  }

  async get(workspaceId: string): Promise<CapabilityCatalogView> {
    const capabilities = await this.#all(workspaceId);
    const skills = capabilities.filter((entry): entry is SkillCapability => entry.kind === "skill");
    const plugins = capabilities.filter((entry): entry is PluginCapability => entry.kind === "plugin");
    const environments = capabilities.filter(
      (entry): entry is EnvironmentCapability => entry.kind === "environment",
    );
    return {
      version: 1,
      workspaceId,
      canonicalRoot: "capabilities",
      skills: skills.map(({ kind: _kind, ...entry }) => entry),
      plugins: plugins.map(({ kind: _kind, ...entry }) => entry),
      environments: environments.map(({ kind: _kind, ...entry }) => ({
        ...entry,
        valueKeys: Object.keys(entry.values).sort(),
      })),
    };
  }

  async upsert(
    workspaceId: string,
    kind: CapabilityKind,
    input: CapabilityUpsertInput,
  ): Promise<WorkspaceCapability> {
    if (kind === "plugin" && input.status === "installed") {
      throw new DomainRuleError(
        "plugin_installation_control_required",
        "Workspace catalog imports cannot mark plugin code as installed.",
      );
    }
    const capability = normalizeWorkspaceCapability(
      kind,
      kind === "plugin" ? { ...input, status: "unavailable" } : input,
      { source: "workspace" },
    );
    if (builtinCapabilities(this.#deepseekPluginInstalled()).some((entry) => entry.id === capability.id)) {
      throw new DomainRuleError(
        "builtin_capability_read_only",
        `Built-in capability '${capability.id}' cannot be replaced.`,
      );
    }
    const conflicting = (await this.#all(workspaceId)).find((entry) => entry.id === capability.id);
    if (conflicting && conflicting.kind !== capability.kind) {
      throw new DomainRuleError(
        "capability_id_conflict",
        `Capability id '${capability.id}' is already used by a ${conflicting.kind}.`,
      );
    }
    const directory = await this.#safeDirectory(workspaceId, capability.kind, true);
    const path = join(directory, capabilityFilename(capability.id));
    const envelope: StoredCapability = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      entity: "capability",
      data: capability,
    };
    await atomicWrite(path, `${JSON.stringify(envelope, null, 2)}\n`);
    return capability;
  }

  async resolve(
    workspaceId: string,
    selection: AgentCapabilitySelection,
    options: { strict?: boolean } = {},
  ): Promise<ResolvedAgentCapabilities> {
    const strict = options.strict ?? true;
    const all = await this.#all(workspaceId);
    const byId = new Map(all.map((entry) => [entry.id, entry]));
    const warnings: string[] = [];
    const skills = selection.skillRefs.flatMap((id) => {
      const entry = byId.get(id);
      if (entry?.kind !== "skill" || entry.status !== "available") {
        if (strict) {
          throw new DomainRuleError("capability_not_found", `Skill '${id}' is not available in this workspace.`);
        }
        warnings.push(`Legacy skill '${id}' was skipped because it is not in the shared catalog.`);
        return [];
      }
      return [entry];
    });
    const plugins = selection.pluginRefs.flatMap((id) => {
      const entry = byId.get(id);
      if (entry?.kind !== "plugin") {
        if (strict) {
          throw new DomainRuleError("capability_not_found", `Plugin '${id}' is not available in this workspace.`);
        }
        warnings.push(`Legacy plugin '${id}' was skipped because it is not in the shared catalog.`);
        return [];
      }
      if (entry.status !== "installed") {
        if (strict) throw new DomainRuleError("plugin_not_installed", `Plugin '${id}' is not installed.`);
        warnings.push(`Plugin '${id}' was skipped because it is not installed by the control runtime.`);
        return [];
      }
      if (!entry.compatibleDrivers.includes(selection.driver)) {
        if (strict) {
          throw new DomainRuleError(
            "plugin_harness_incompatible",
            `Plugin '${id}' is not compatible with harness '${selection.driver}'.`,
          );
        }
        warnings.push(`Plugin '${id}' was skipped because it is incompatible with harness '${selection.driver}'.`);
        return [];
      }
      return [entry];
    });
    let environment = selection.environment.reference === null
      ? null
      : byId.get(selection.environment.reference);
    if (environment !== null && environment?.kind !== "environment") {
      if (strict) {
        throw new DomainRuleError(
          "capability_not_found",
          `Environment '${selection.environment.reference}' is not available in this workspace.`,
        );
      }
      warnings.push(`Legacy environment '${selection.environment.reference}' has no shared catalog values; only its inline safe values were used.`);
      environment = undefined;
    }
    const inlineValues = strict
      ? selection.environment.values
      : safeLegacyEnvironmentValues(selection.environment.values, warnings);
    const safeEnvironment = normalizeAgentEnvironment({
      reference: selection.environment.reference,
      values: {
        ...(environment?.kind === "environment" ? environment.values : {}),
        ...inlineValues,
      },
    });
    const promptSections = [
      ...skills.map((entry) => capabilityPrompt("Skill", entry.id, entry.name, entry.instructions)),
      ...plugins.map((entry) => capabilityPrompt(
        "Plugin (instructions-only; no executable code is loaded by Mob)",
        entry.id,
        entry.name,
        entry.instructions,
      )),
    ];
    return {
      skills,
      plugins,
      environment: environment?.kind === "environment" ? environment : null,
      environmentValues: { ...safeEnvironment.values },
      promptContext: promptSections.filter(Boolean).join("\n\n"),
      warnings,
    };
  }

  async #all(workspaceId: string): Promise<WorkspaceCapability[]> {
    await this.#projectBuiltins(workspaceId);
    const values = new Map<string, WorkspaceCapability>();
    for (const entry of builtinCapabilities(this.#deepseekPluginInstalled())) values.set(entry.id, entry);
    for (const kind of ["skill", "plugin", "environment"] as const) {
      for (const entry of await this.#readKind(workspaceId, kind)) {
        if (!values.has(entry.id)) values.set(entry.id, entry);
      }
    }
    return [...values.values()].sort((left, right) =>
      left.kind === right.kind ? left.name.localeCompare(right.name) || left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind),
    );
  }

  async #projectBuiltins(workspaceId: string): Promise<void> {
    for (const capability of builtinCapabilities(this.#deepseekPluginInstalled())) {
      const directory = await this.#safeDirectory(workspaceId, capability.kind, true);
      const envelope: StoredCapability = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entity: "capability",
        data: capability,
      };
      await atomicWrite(
        join(directory, capabilityFilename(capability.id)),
        `${JSON.stringify(envelope, null, 2)}\n`,
      );
    }
  }

  async #readKind(workspaceId: string, kind: CapabilityKind): Promise<WorkspaceCapability[]> {
    let directory: string;
    try {
      directory = await this.#safeDirectory(workspaceId, kind, false);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    if (names.length > 256) {
      throw new DomainRuleError("capability_catalog_too_large", "A capability directory supports at most 256 entries.");
    }
    const values: WorkspaceCapability[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new DomainRuleError("unsafe_capability_path", `Capability file '${name}' cannot be a symlink.`);
      }
      if (!stats.isFile()) continue;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let source: string;
      try {
        const openedStats = await handle.stat();
        if (!openedStats.isFile()) continue;
        source = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      let envelope: StoredCapability;
      try {
        envelope = JSON.parse(source) as StoredCapability;
      } catch {
        throw new DomainRuleError("invalid_capability_file", `Capability file '${name}' is invalid JSON.`);
      }
      if (
        envelope.schemaVersion !== CATALOG_SCHEMA_VERSION ||
        envelope.entity !== "capability" ||
        envelope.data?.kind !== kind
      ) {
        throw new DomainRuleError("invalid_capability_file", `Capability file '${name}' has an invalid envelope.`);
      }
      values.push(normalizeWorkspaceCapability(kind, kind === "plugin"
        ? { ...envelope.data, status: "unavailable" }
        : envelope.data, {
        source: "workspace",
        updatedAt: envelope.data.updatedAt,
      }));
    }
    return values;
  }

  async #safeDirectory(workspaceId: string, kind: CapabilityKind, create: boolean): Promise<string> {
    const root = resolve(this.#options.workspaceRoot(workspaceId));
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(root, "workspace capability root");
    let current = root;
    for (const segment of ["capabilities", capabilityDirectories[kind]]) {
      current = join(current, segment);
      if (create) {
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        });
      }
      await assertPlainDirectory(current, "workspace capability directory");
    }
    const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(current)]);
    if (!isWithin(realRoot, realDirectory)) {
      throw new DomainRuleError("unsafe_capability_path", "Capability directory escapes the workspace root.");
    }
    return current;
  }

  #deepseekPluginInstalled(): boolean {
    return this.#options.deepseekPluginInstalled ?? existsSync(
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/mob-agent-crew-dsh-plugin/index.js",
    );
  }
}

function builtinCapabilities(deepseekPluginInstalled: boolean): WorkspaceCapability[] {
  const common = { source: "builtin" as const, updatedAt: BUILTIN_UPDATED_AT };
  return [
    normalizeWorkspaceCapability("skill", {
      id: "mob:repository-knowledge",
      name: "Repository knowledge",
      description: "Use the task repository Wiki excerpts already retrieved by Mob.",
      instructions: "Ground repository-specific claims in the Workspace knowledge excerpts supplied in this run. Cite their source paths when useful and do not invent missing facts.",
    }, common),
    normalizeWorkspaceCapability("skill", {
      id: "mob:collaboration",
      name: "Mob collaboration",
      description: "Coordinate through Mob messages, delegations, artifacts, and completion.",
      instructions: "Use mob say for meaningful progress, mob delegate for bounded Agent handoffs, mob artifact add for deliverables, and mob done exactly once with the final result.",
    }, common),
    normalizeWorkspaceCapability("plugin", {
      id: "mob:deepseek-harness",
      name: "Mob Agent Crew for DeepSeek Harness",
      description: deepseekPluginInstalled
        ? "The bundled Mob Agent Crew plugin is installed in DeepSeek Harness."
        : "The Mob plugin is not installed in this runtime image.",
      status: deepseekPluginInstalled ? "installed" : "unavailable",
      compatibleDrivers: ["deepseek"],
      instructions: "Use the bundled Mob Agent Crew plugin surfaces for task context and collaboration. Mob remains the authority for runs, writer leases, artifacts, Wiki files, and publication approval.",
    }, common),
    normalizeWorkspaceCapability("environment", {
      id: "railway:default",
      name: "Railway default",
      description: "The default secret-free Railway runtime profile.",
      values: { MOB_ENVIRONMENT_KIND: "railway" },
    }, common),
    normalizeWorkspaceCapability("environment", {
      id: "local:default",
      name: "Local default",
      description: "The default secret-free local runtime profile.",
      values: { MOB_ENVIRONMENT_KIND: "local" },
    }, common),
  ];
}

function capabilityPrompt(kind: string, id: string, name: string, instructions: string): string {
  return [`${kind}: ${name} (${id})`, instructions].filter(Boolean).join("\n");
}

function safeLegacyEnvironmentValues(
  values: Readonly<Record<string, string>>,
  warnings: string[],
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    try {
      const normalized = normalizeAgentEnvironment({ reference: null, values: { [key]: value } });
      Object.assign(safe, normalized.values);
    } catch {
      warnings.push(`Legacy environment value '${key}' was skipped because it is unsafe or reserved.`);
    }
  }
  return safe;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await assertPlainDirectory(dirname(path), "workspace capability directory");
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await existing.readFile("utf8")) === content) return;
    } finally {
      await existing.close();
    }
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ELOOP")) throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function capabilityFilename(id: string): string {
  const readable = id.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72) || "capability";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `${readable}--${digest}.json`;
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new DomainRuleError("unsafe_capability_path", `${label} must be a real directory.`);
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
