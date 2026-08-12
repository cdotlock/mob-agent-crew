import type { AgentRunInput } from "./types.js";

export interface CliDriverOptions {
  readonly command?: string;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envAllowlist?: readonly string[];
  readonly killGraceMs?: number;
  readonly maxFrameBytes?: number;
}

export function mergeRunEnvironment(
  driverEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  runEnvironment: AgentRunInput["env"],
): Readonly<Record<string, string | undefined>> {
  return { ...(driverEnvironment ?? {}), ...(runEnvironment ?? {}) };
}
