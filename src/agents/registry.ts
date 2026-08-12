import { ClaudeCodeDriver } from "./claude-driver.js";
import { CodexExecDriver } from "./codex-driver.js";
import { MockDriver } from "./mock-driver.js";
import { OmpRpcDriver } from "./omp-rpc-driver.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { CliDriverOptions } from "./driver-options.js";
import type { AgentDriver, AgentDriverId } from "./types.js";

export class AgentDriverRegistry {
  readonly #drivers = new Map<AgentDriverId, AgentDriver>();

  constructor(drivers: Iterable<AgentDriver> = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: AgentDriver, options: { readonly replace?: boolean } = {}): this {
    if (this.#drivers.has(driver.id) && options.replace !== true) {
      throw new Error(`Agent driver '${driver.id}' is already registered`);
    }
    this.#drivers.set(driver.id, driver);
    return this;
  }

  has(id: AgentDriverId): boolean {
    return this.#drivers.has(id);
  }

  get(id: AgentDriverId): AgentDriver {
    const driver = this.#drivers.get(id);
    if (!driver) throw new Error(`Agent driver '${id}' is not registered`);
    return driver;
  }

  list(): readonly AgentDriver[] {
    return [...this.#drivers.values()];
  }
}

export interface DefaultAgentDriverRegistryOptions {
  readonly mock?: MockDriver;
  readonly codex?: CliDriverOptions;
  readonly claude?: CliDriverOptions;
  readonly pi?: CliDriverOptions;
  readonly omp?: CliDriverOptions;
}

export function createDefaultAgentDriverRegistry(
  options: DefaultAgentDriverRegistryOptions = {},
): AgentDriverRegistry {
  return new AgentDriverRegistry([
    options.mock ?? new MockDriver(),
    new CodexExecDriver(options.codex),
    new ClaudeCodeDriver(options.claude),
    new PiRpcDriver(options.pi),
    new OmpRpcDriver(options.omp),
  ]);
}
