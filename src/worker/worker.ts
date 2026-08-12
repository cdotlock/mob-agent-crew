import { join } from "node:path";
import type { AgentDriverId, AgentDriverRegistry, AgentRun } from "../agents/index.js";
import type { AppConfig } from "../config.js";
import type { CollaborationStore } from "../db/store.js";
import type { LeaseClaim } from "../domain/model.js";
import { issueRunToken } from "../auth/tokens.js";
import { redactText, redactValue } from "../security/redaction.js";
import { materializeGitWorkspace } from "../workspace/materialize.js";

export interface WorkerOptions {
  id: string;
  store: CollaborationStore;
  drivers: AgentDriverRegistry;
  config: AppConfig;
  pollMs?: number;
  leaseMs?: number;
}

type RuntimeProfile = {
  driver: AgentDriverId;
  home: string;
  role: string;
};

type TaskRepository = {
  remoteUrl: string | null;
  baseRevision: string;
  allowlisted: boolean;
  enabled: boolean;
};

export class MobWorker {
  readonly #options: WorkerOptions;
  readonly #active = new Map<string, AgentRun>();
  #stopping = false;
  #loop: Promise<void> | undefined;

  constructor(options: WorkerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#loop) return;
    this.#stopping = false;
    this.#loop = this.#runLoop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.all([...this.#active.values()].map((run) => run.cancel("Worker stopping")));
    await this.#loop;
    this.#loop = undefined;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const active = this.#active.get(runId);
    if (!active) return false;
    await active.cancel("Cancelled by a collaborator");
    return true;
  }

  async tick(): Promise<boolean> {
    const claim = await this.#options.store.claimNextRun(
      this.#options.id,
      this.#options.leaseMs ?? 60_000,
    );
    if (!claim) return false;
    await this.#execute(claim);
    return true;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      try {
        const worked = await this.tick();
        if (!worked) await delay(this.#options.pollMs ?? 750);
      } catch (error) {
        console.error("worker tick failed", error);
        await delay(this.#options.pollMs ?? 750);
      }
    }
  }

  async #loadProfile(claim: LeaseClaim): Promise<RuntimeProfile> {
    const rows = await this.#options.store.sql<RuntimeProfile[]>`
      SELECT driver, home, role
      FROM agent_profiles
      WHERE actor_id = ${claim.agentActorId} AND workspace_id = ${claim.workspaceId}
    `;
    const profile = rows[0];
    if (!profile) throw new Error(`Agent profile ${claim.agentActorId} was not found`);
    return profile;
  }

  async #buildPrompt(claim: LeaseClaim, role: string): Promise<string> {
    const thread = await this.#options.store.getTaskThread(claim.taskId);
    const transcript = thread.messages
      .slice(-30)
      .map((message) => `${message.actorId}: ${message.body}`)
      .join("\n");
    return [
      `You are participating as ${role || "a coding agent"} in a shared Mob Agent Crew task.`,
      `Task: ${thread.task.title}`,
      thread.task.description ? `Description: ${thread.task.description}` : "",
      "Use the mob CLI for collaboration. Post concise progress, delegate only bounded deliverables, and finish with mob done.",
      "Never print environment variables, tokens, or credentials. Do not inspect runtime plumbing unless the task explicitly asks for it.",
      transcript ? `Shared thread:\n${transcript}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async #prepareTaskDirectory(claim: LeaseClaim): Promise<string> {
    const taskDirectory = join(this.#options.config.dataDir, "tasks", claim.taskId);
    const rows = await this.#options.store.sql<TaskRepository[]>`
      SELECT r.remote_url AS "remoteUrl", t.base_revision AS "baseRevision",
             r.allowlisted, r.enabled
      FROM tasks t
      JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
      WHERE t.id = ${claim.taskId} AND t.workspace_id = ${claim.workspaceId}
    `;
    const repository = rows[0];
    if (!repository?.allowlisted || !repository.enabled || !repository.remoteUrl) {
      throw new Error("Task repository is not an enabled allowlisted Git remote");
    }
    await materializeGitWorkspace({
      taskDirectory,
      remoteUrl: repository.remoteUrl,
      baseRevision: repository.baseRevision,
    });
    return taskDirectory;
  }

  async #execute(claim: LeaseClaim): Promise<void> {
    let nativeRun: AgentRun | undefined;
    try {
      const profile = await this.#loadProfile(claim);
      if (profile.driver !== "mock" && !this.#options.drivers.has(profile.driver)) {
        throw new Error(`Agent driver '${profile.driver}' is not registered`);
      }
      const driver = this.#options.drivers.get(profile.driver);
      await this.#options.store.markAttemptRunning(claim);

      const taskDir = await this.#prepareTaskDirectory(claim);
      const token = issueRunToken(
        {
          actorId: claim.agentActorId,
          workspaceId: claim.workspaceId,
          runId: claim.runId,
          taskId: claim.taskId,
        },
        this.#options.config.sessionSecret,
      );

      nativeRun = await driver.run({
        jobId: claim.runId,
        attemptId: claim.attemptId,
        prompt: await this.#buildPrompt(claim, profile.role),
        cwd: taskDir,
        timeoutMs: 30 * 60_000,
        env: {
          PI_CODING_AGENT_DIR: profile.home,
          ...(this.#options.config.mobAiKey ? { MOB_AI_KEY: this.#options.config.mobAiKey } : {}),
          MOB_API_URL: this.#options.config.publicUrl ?? `http://127.0.0.1:${this.#options.config.port}`,
          MOB_RUN_TOKEN: token,
        },
      });
      this.#active.set(claim.runId, nativeRun);
      const runtimeSecrets = [this.#options.config.mobAiKey, token];

      for await (const event of nativeRun) {
        await this.#options.store.appendRunEvent({
          claim,
          type: event.kind,
          payload: redactValue({
            driver: event.driver,
            sequence: event.sequence,
            ...(event.nativeType ? { nativeType: event.nativeType } : {}),
            ...(event.message ? { message: event.message } : {}),
            ...(event.data ?? {}),
          }, runtimeSecrets),
        });
      }
      const result = await nativeRun.result;
      const status = result.outcome === "completed" ? "succeeded" : result.outcome === "cancelled" ? "cancelled" : "failed";
      await this.#options.store.completeAttempt({
        claim,
        status,
        ...(result.error ? { failureMessage: result.error } : {}),
        ...(result.outcome === "timed_out" ? { failureCode: "timeout" } : {}),
      });

      if (result.finalMessage) {
        await this.#options.store.createMessage({
          taskId: claim.taskId,
          actorId: claim.agentActorId,
          sourceRunId: claim.runId,
          kind: status === "succeeded" ? "result" : "progress",
          body: redactText(result.finalMessage, runtimeSecrets),
          enqueueMentionedAgents: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.#options.store.completeAttempt({
          claim,
          status: "failed",
          failureCode: "worker_error",
          failureMessage: message,
        });
      } catch (completionError) {
        console.error("failed to record worker failure", completionError);
      }
    } finally {
      this.#active.delete(claim.runId);
      if (nativeRun) await nativeRun.forceKill().catch(() => undefined);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
