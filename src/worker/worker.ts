import { join } from "node:path";
import {
  type AgentCommand,
  type AgentCommandAck,
  type AgentDriverId,
  type AgentDriverRegistry,
  type AgentRun,
  writeMobAiProviderConfig,
} from "../agents/index.js";
import type { AppConfig } from "../config.js";
import type { CollaborationStore } from "../db/store.js";
import type { LeaseClaim } from "../domain/model.js";
import { issueRunToken } from "../auth/tokens.js";
import { controlRepositoryDirectory, materializeGitWorkspace } from "../workspace/materialize.js";
import { grantAgentWorkspace, revokeAgentWorkspace } from "../workspace/agent-access.js";
import { syncRepositoryKnowledge, WorkspaceKnowledge } from "../knowledge/index.js";
import { type FileWorkspaceStore, writeTaskFileState } from "../storage/index.js";
import {
  agentOutputPersistence,
  redactRuntimeError,
  redactRuntimePayload,
  redactedRuntimeError,
} from "./runtime-redaction.js";
import { runConversationContext } from "./prompt-context.js";
import { CapabilityCatalogService, type ResolvedAgentCapabilities } from "../capabilities/index.js";

export interface WorkerOptions {
  id: string;
  store: CollaborationStore;
  files: FileWorkspaceStore;
  drivers: AgentDriverRegistry;
  config: AppConfig;
  pollMs?: number;
  leaseMs?: number;
}

type RuntimeProfile = {
  driver: AgentDriverId;
  home: string;
  role: string;
  modelId: string | null;
  skillRefs: string[];
  pluginRefs: string[];
  environment: {
    reference: string | null;
    values: Record<string, string>;
  };
};

type TaskRepository = {
  name: string;
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

  async sendRunCommand(runId: string, command: AgentCommand): Promise<AgentCommandAck> {
    const active = this.#active.get(runId);
    if (!active) {
      return { accepted: false, command: command.type, error: "Agent run is not active on this worker" };
    }
    try {
      const acknowledgement = await active.send(command);
      return acknowledgement.accepted
        ? acknowledgement
        : {
            accepted: false,
            command: acknowledgement.command,
            error: "Agent connector rejected the command",
          };
    } catch {
      return {
        accepted: false,
        command: command.type,
        error: "Agent connector does not support this command",
      };
    }
  }

  async tick(): Promise<boolean> {
    const claim = await this.#options.store.claimNextRun(
      this.#options.id,
      this.#options.leaseMs ?? 60_000,
    );
    if (!claim) return false;
    await writeTaskFileState(this.#options.store, this.#options.files, claim.taskId);
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
      SELECT driver, home, role,
             model_id AS "modelId",
             skill_refs AS "skillRefs",
             plugin_refs AS "pluginRefs",
             environment
      FROM agent_profiles
      WHERE actor_id = ${claim.agentActorId} AND workspace_id = ${claim.workspaceId}
    `;
    const profile = rows[0];
    if (!profile) throw new Error(`Agent profile ${claim.agentActorId} was not found`);
    const expectedHome = join(this.#options.config.dataDir, "agents", claim.agentActorId);
    if (profile.home !== expectedHome) {
      throw new Error(`Agent profile ${claim.agentActorId} has an invalid home directory`);
    }
    return {
      ...profile,
      modelId: profile.modelId ?? null,
      skillRefs: Array.isArray(profile.skillRefs) ? profile.skillRefs : [],
      pluginRefs: Array.isArray(profile.pluginRefs) ? profile.pluginRefs : [],
      environment: profile.environment && typeof profile.environment === "object"
        ? {
            reference: profile.environment.reference ?? null,
            values: profile.environment.values ?? {},
          }
        : { reference: null, values: {} },
    };
  }

  async #buildPrompt(
    claim: LeaseClaim,
    profile: RuntimeProfile,
    capabilities: ResolvedAgentCapabilities,
  ): Promise<string> {
    const [thread, actors] = await Promise.all([
      this.#options.store.getTaskThread(claim.taskId),
      this.#options.store.listActors(claim.workspaceId),
    ]);
    const { messages: conversationMessages, currentInstruction } = runConversationContext(
      thread,
      claim.runId,
    );
    const transcript = conversationMessages
      .slice(-30)
      .map((message) => `${message.actorId}: ${message.body}`)
      .join("\n");
    const knowledgeQuery = [
      thread.task.title,
      currentInstruction,
      ...conversationMessages.slice(-5).map((message) => message.body),
    ].filter(Boolean).join("\n");
    const knowledge = new WorkspaceKnowledge({
      rootDirectory: join(this.#options.files.workspaceRoot(claim.workspaceId), "knowledge"),
    });
    const retrieval = await knowledge.retrieve(knowledgeQuery, { topK: 4, charBudget: 8_000 });
    const collaborators = actors
      .filter((actor) => actor.kind === "agent" && actor.status === "active" && actor.id !== claim.agentActorId)
      .map((actor) => `@${actor.handle}`)
      .join(", ");
    return [
      `You are participating as ${profile.role || "a coding agent"} in a shared Mob Agent Crew task.`,
      profile.skillRefs.length
        ? `Requested shared skill references: ${profile.skillRefs.join(", ")}. Only catalog entries whose instructions appear below are active.`
        : "",
      profile.pluginRefs.length
        ? `Requested shared plugin references: ${profile.pluginRefs.join(", ")}. Mob loads instructions only, never arbitrary plugin code.`
        : "",
      profile.environment.reference
        ? `Configured environment reference: ${profile.environment.reference}`
        : "",
      capabilities.promptContext
        ? `Selected shared capabilities (trusted, secret-free instructions):\n${capabilities.promptContext}`
        : "",
      capabilities.warnings.length
        ? `Capability warnings:\n${capabilities.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "",
      `Task: ${thread.task.title}`,
      thread.task.description && currentInstruction !== thread.task.description
        ? `Task background (context only, not the current instruction): ${thread.task.description}`
        : "",
      "Start the requested work immediately. Do not explore the Mob platform or inspect mob --help/context unless the user explicitly asks.",
      "Use mob say only for meaningful progress, mob delegate only for a bounded handoff, mob artifact add for deliverables, and mob done once when finished.",
      collaborators ? `Available Agent collaborators: ${collaborators}. Invoke one with mob delegate @handle \"bounded deliverable\".` : "",
      "Never print environment variables, tokens, or credentials. Do not inspect runtime plumbing unless the task explicitly asks for it.",
      transcript ? `Current conversation:\n${transcript}` : "",
      retrieval.context
        ? `Workspace knowledge (read-only excerpts; source manifest ${retrieval.manifestPath}):\n${retrieval.context}`
        : "",
      currentInstruction
        ? `Current instruction (execute this now; it overrides older task text and transcript messages):\n${currentInstruction}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async #prepareTaskDirectory(claim: LeaseClaim): Promise<string> {
    const taskDirectory = join(this.#options.config.dataDir, "tasks", claim.taskId);
    const rows = await this.#options.store.sql<TaskRepository[]>`
      SELECT r.name, r.remote_url AS "remoteUrl", t.base_revision AS "baseRevision",
             r.allowlisted, r.enabled
      FROM tasks t
      JOIN repositories r ON r.id = t.repository_id AND r.workspace_id = t.workspace_id
      WHERE t.id = ${claim.taskId} AND t.workspace_id = ${claim.workspaceId}
    `;
    const repository = rows[0];
    if (!repository?.allowlisted || !repository.enabled || !repository.remoteUrl) {
      throw new Error("Task repository is not an enabled allowlisted Git remote");
    }
    const materialized = await materializeGitWorkspace({
      taskDirectory,
      controlDirectory: controlRepositoryDirectory(this.#options.config.dataDir, claim.taskId),
      remoteUrl: repository.remoteUrl,
      baseRevision: repository.baseRevision,
    });
    await syncRepositoryKnowledge({
      checkoutDirectory: taskDirectory,
      repositoryName: repository.name,
      remoteUrl: repository.remoteUrl,
      revision: materialized.baseCommit,
      knowledge: new WorkspaceKnowledge({
        rootDirectory: join(this.#options.files.workspaceRoot(claim.workspaceId), "knowledge"),
      }),
    });
    return taskDirectory;
  }

  async #execute(claim: LeaseClaim): Promise<void> {
    let nativeRun: AgentRun | undefined;
    let taskDir: string | undefined;
    let leaseLost = false;
    let renewingLease = false;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    const runtimeSecrets: (string | undefined)[] = [
      this.#options.config.mobAiKey,
      claim.token,
    ];
    try {
      const profile = await this.#loadProfile(claim);
      const capabilities = await new CapabilityCatalogService({
        workspaceRoot: (workspaceId) => this.#options.files.workspaceRoot(workspaceId),
      }).resolve(claim.workspaceId, {
        driver: profile.driver,
        skillRefs: profile.skillRefs,
        pluginRefs: profile.pluginRefs,
        environment: profile.environment,
      }, { strict: false });
      if (profile.driver !== "mock" && !this.#options.drivers.has(profile.driver)) {
        throw new Error(`Agent driver '${profile.driver}' is not registered`);
      }
      const driver = this.#options.drivers.get(profile.driver);
      const runningAttempt = await this.#options.store.markAttemptRunning(claim);
      await this.#options.files.writeAttempt(runningAttempt);
      for (const warning of capabilities.warnings) {
        const event = await this.#options.store.appendRunEvent({
          claim,
          type: "capability.warning",
          payload: { message: warning },
        });
        await this.#options.files.writeEvent(event);
      }
      const syncing = await this.#options.store.appendRunEvent({
        claim,
        type: "workspace.sync.started",
        payload: { message: "Preparing the repository and workspace knowledge" },
      });
      await this.#options.files.writeEvent(syncing);

      const leaseMs = this.#options.leaseMs ?? 60_000;
      leaseHeartbeat = setInterval(async () => {
        if (renewingLease) return;
        renewingLease = true;
        try {
          const renewed = await this.#options.store.renewLease(claim, leaseMs);
          if (!renewed) {
            leaseLost = true;
            if (nativeRun) await nativeRun.cancel("Worker lease was lost");
          }
        } catch (error) {
          console.error(
            `failed to renew lease for run ${claim.runId}`,
            redactedRuntimeError(error, runtimeSecrets),
          );
        } finally {
          renewingLease = false;
        }
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      leaseHeartbeat.unref();

      taskDir = await this.#prepareTaskDirectory(claim);
      await grantAgentWorkspace(taskDir);
      const synced = await this.#options.store.appendRunEvent({
        claim,
        type: "workspace.sync.completed",
        payload: { message: "Repository checkout and Wiki context are ready" },
      });
      await this.#options.files.writeEvent(synced);
      if (leaseLost) throw new Error("Worker lease was lost while preparing the task workspace");
      const token = issueRunToken(
        {
          actorId: claim.agentActorId,
          workspaceId: claim.workspaceId,
          runId: claim.runId,
          attemptId: claim.attemptId,
          taskId: claim.taskId,
        },
        this.#options.config.sessionSecret,
      );
      runtimeSecrets.push(token);

      if (profile.driver !== "mock") {
        const effectiveModel = profile.modelId ?? defaultModelForDriver(this.#options.config, profile.driver);
        await writeMobAiProviderConfig({
          directory: profile.home,
          baseUrl: `http://127.0.0.1:${this.#options.config.port}/api/provider`,
          model: profile.driver === "claude" || profile.driver === "codex"
            ? this.#options.config.mobAiModel
            : effectiveModel,
          claudeModel: profile.driver === "claude"
            ? effectiveModel
            : this.#options.config.mobAiClaudeModel,
          codexModel: profile.driver === "codex"
            ? effectiveModel
            : this.#options.config.mobAiCodexModel,
        });
      }

      const effectiveModel = profile.modelId ?? defaultModelForDriver(this.#options.config, profile.driver);

      nativeRun = await driver.run({
        jobId: claim.runId,
        attemptId: claim.attemptId,
        prompt: await this.#buildPrompt(claim, profile, capabilities),
        cwd: taskDir,
        timeoutMs: 30 * 60_000,
        ...(profile.driver !== "mock" ? { profileDirectory: profile.home } : {}),
        env: {
          ...capabilities.environmentValues,
          ...agentRuntimeProviderEnvironment(this.#options.config, token),
          MOB_AI_MODEL: profile.driver === "claude" || profile.driver === "codex"
            ? this.#options.config.mobAiModel
            : effectiveModel,
          MOB_AI_CLAUDE_MODEL: profile.driver === "claude"
            ? effectiveModel
            : this.#options.config.mobAiClaudeModel ?? "claude-opus-4-6:free",
          MOB_AI_CODEX_MODEL: profile.driver === "codex"
            ? effectiveModel
            : this.#options.config.mobAiCodexModel ?? "gpt-5.6-sol",
          MOB_API_URL: this.#options.config.publicUrl ?? `http://127.0.0.1:${this.#options.config.port}`,
          MOB_RUN_TOKEN: token,
        },
        metadata: {
          modelId: effectiveModel,
          skillRefs: profile.skillRefs,
          pluginRefs: profile.pluginRefs,
          environmentReference: profile.environment.reference,
          capabilityWarnings: capabilities.warnings,
        },
      });
      this.#active.set(claim.runId, nativeRun);

      for await (const event of nativeRun) {
        const storedEvent = await this.#options.store.appendRunEvent({
          claim,
          type: event.kind,
          payload: redactRuntimePayload({
            driver: event.driver,
            sequence: event.sequence,
            ...(event.nativeType ? { nativeType: event.nativeType } : {}),
            ...(event.message ? { message: event.message } : {}),
            ...(event.data ?? {}),
          }, runtimeSecrets),
        });
        await this.#options.files.writeEvent(storedEvent);
      }
      const result = await nativeRun.result;
      const threadAfterRun = await this.#options.store.getTaskThread(claim.taskId);
      const runContext = runConversationContext(threadAfterRun, claim.runId);
      const resultAlreadyPosted = threadAfterRun.messages.some(
        (message) => message.sourceRunId === claim.runId && message.kind === "result",
      );
      const missingResult = result.outcome === "completed" && !result.finalMessage && !resultAlreadyPosted;
      const status = missingResult
        ? "failed"
        : result.outcome === "completed"
          ? "succeeded"
          : result.outcome === "cancelled"
            ? "cancelled"
            : "failed";
      const completed = await this.#options.store.completeAttempt({
        claim,
        status,
        ...(missingResult
          ? { failureCode: "missing_result", failureMessage: "Agent exited without posting mob done or returning a final message." }
          : result.error
            ? { failureMessage: redactRuntimeError(result.error, runtimeSecrets) }
            : {}),
        ...(!missingResult && result.outcome === "timed_out" ? { failureCode: "timeout" } : {}),
      });
      await Promise.all([
        this.#options.files.writeRun(completed.run),
        this.#options.files.writeAttempt(completed.attempt),
      ]);

      if (missingResult) {
        const posted = await this.#options.store.createConversationMessage({
          conversationId: runContext.run.conversationId,
          actorId: claim.agentActorId,
          sourceRunId: claim.runId,
          kind: "progress",
          body: "I stopped without publishing a final result. The run has been marked failed so it can be retried safely.",
        });
        await this.#options.files.writeMessage(posted.message);
      }

      if (result.finalMessage) {
        if (!resultAlreadyPosted) {
          const posted = await this.#options.store.createConversationMessage({
            conversationId: runContext.run.conversationId,
            actorId: claim.agentActorId,
            sourceRunId: claim.runId,
            kind: status === "succeeded" ? "result" : "progress",
            ...agentOutputPersistence(result.finalMessage, runtimeSecrets),
          });
          await this.#options.files.writeMessage(posted.message);
        }
      }
    } catch (error) {
      const message = redactRuntimeError(error, runtimeSecrets);
      try {
        const failedEvent = await this.#options.store.appendRunEvent({
          claim,
          type: "error",
          payload: { message },
        });
        await this.#options.files.writeEvent(failedEvent);
      } catch {
        // A lost/expired lease cannot append an event; completion below will
        // make the same lease check and preserves the original safe error.
      }
      try {
        const completed = await this.#options.store.completeAttempt({
          claim,
          status: "failed",
          failureCode: "worker_error",
          failureMessage: message,
        });
        await Promise.all([
          this.#options.files.writeRun(completed.run),
          this.#options.files.writeAttempt(completed.attempt),
        ]);
      } catch (completionError) {
        console.error(
          "failed to record worker failure",
          redactedRuntimeError(completionError, runtimeSecrets),
        );
      }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      this.#active.delete(claim.runId);
      if (nativeRun) await nativeRun.forceKill().catch(() => undefined);
      if (taskDir) {
        await revokeAgentWorkspace(taskDir).catch((error) => {
          console.error(
            `failed to revoke workspace access for run ${claim.runId}`,
            redactedRuntimeError(error, runtimeSecrets),
          );
        });
      }
      await writeTaskFileState(this.#options.store, this.#options.files, claim.taskId).catch((error) => {
        console.error(
          `failed to refresh file state for task ${claim.taskId}`,
          redactedRuntimeError(error, runtimeSecrets),
        );
      });
    }
  }
}

export function agentRuntimeProviderEnvironment(
  config: Pick<AppConfig, "port" | "mobAiKey">,
  runToken: string,
): Readonly<Record<string, string>> {
  return {
    ...(config.mobAiKey ? { MOB_AI_KEY: runToken } : {}),
    MOB_AI_BASE_URL: `http://127.0.0.1:${config.port}/api/provider`,
  };
}

function defaultModelForDriver(config: AppConfig, driver: AgentDriverId): string {
  if (driver === "claude") return config.mobAiClaudeModel ?? config.mobAiModel;
  if (driver === "codex") return config.mobAiCodexModel ?? config.mobAiModel;
  return config.mobAiModel;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
