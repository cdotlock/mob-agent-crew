#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { Command } from "commander";
import { createDefaultAgentDriverRegistry, MockDriver } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { createCollaborationStore, createDatabaseClient, migrateDatabase } from "./db/index.js";
import { buildApp, ensureBootstrap } from "./server/index.js";
import { MobWorker } from "./worker/index.js";
import { FileWorkspaceStore, replayWorkspaceProjection } from "./storage/index.js";
import {
  MobApiClient,
  MobApiError,
  clearClientConfig,
  importWikiDirectory,
  loadClientConfig,
  normalizeServerUrl,
  saveClientConfig,
} from "./client/index.js";

interface ListedAgent {
  id: string;
  handle: string;
  name: string;
  role: string;
  driver?: string;
  harness?: string;
  modelId?: string | null;
  skillRefs?: string[];
  pluginRefs?: string[];
  environment?: {
    reference?: string | null;
    values?: Record<string, string>;
  } | null;
}

interface AgentListResponse {
  agents?: ListedAgent[];
}

interface AgentAddOptions {
  handle: string;
  name: string;
  driver: string;
  role: string;
  model?: string;
  skill?: string[];
  plugin?: string[];
  environment?: string;
}

interface AgentConfigureOptions {
  name?: string;
  role?: string;
  driver?: string;
  model?: string;
  defaultModel?: boolean;
  skill?: string[];
  clearSkills?: boolean;
  plugin?: string[];
  clearPlugins?: boolean;
  environment?: string;
  clearEnvironment?: boolean;
}

const program = new Command()
  .name("mob")
  .description("Shared collaboration for humans and CLI coding agents")
  .version("0.1.0");

program.command("start").description("start the web app and embedded worker").action(() => runServer(true));
program.command("serve").description("start the web app without a worker").action(() => runServer(false));
program.command("worker").description("start a worker process").action(runWorker);

program.command("login")
  .description("connect this computer to a Mob environment")
  .requiredOption("--server <url>", "Mob server URL")
  .option("--email <email>", "account email")
  .option("--password-stdin", "read the account password from stdin")
  .option("--token-stdin", "read an existing scoped token from stdin")
  .action(async (options: { server: string; email?: string; passwordStdin?: boolean; tokenStdin?: boolean }) => {
    const server = normalizeServerUrl(options.server);
    if (options.passwordStdin && options.tokenStdin) throw new Error("Choose password stdin or token stdin, not both");
    let token: string;
    if (options.tokenStdin) {
      token = (await readStandardInput()).trim();
      if (!token) throw new Error("No token was received on stdin");
      await new MobApiClient({ server, token }).request("/api/bootstrap");
    } else {
      if (!options.email) throw new Error("--email is required when logging in with a password");
      const password = options.passwordStdin
        ? (await readStandardInput()).trimEnd()
        : process.env.MOB_PASSWORD;
      if (!password) throw new Error("Use --password-stdin or set MOB_PASSWORD");
      const response = await new MobApiClient({ server }).request<{ token?: string }>("/api/session", {
        method: "POST",
        body: { email: options.email, password, client: "cli" },
      });
      if (!response.token) throw new Error("Mob server did not issue a CLI token");
      token = response.token;
    }
    await saveClientConfig({ server, token });
    console.log(`Connected to ${server}`);
  });

program.command("logout").description("remove this computer's Mob credential").action(async () => {
  console.log((await clearClientConfig()) ? "Mob credential removed." : "No Mob credential was stored.");
});

const taskCommands = program.command("task").description("work with tasks in the connected Mob environment");
taskCommands.command("list").action(async () => {
  const client = await connectedClient();
  const bootstrap = await client.request<{ tasks?: unknown[] }>("/api/bootstrap");
  console.log(JSON.stringify(bootstrap.tasks ?? [], null, 2));
});
taskCommands.command("show").argument("<task-id>").action(async (taskId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/tasks/${encodeURIComponent(taskId)}`), null, 2));
});
taskCommands.command("review")
  .argument("<task-id>")
  .option("--accept", "accept the reviewable result")
  .option("--request-changes", "reopen the task for a bounded follow-up")
  .option("--reject", "reject and cancel the result")
  .option("--note <note>", "human review note", "")
  .action(async (taskId: string, options: {
    accept?: boolean;
    requestChanges?: boolean;
    reject?: boolean;
    note: string;
  }) => {
    const decisions = [
      options.accept ? "accept" : null,
      options.requestChanges ? "request_changes" : null,
      options.reject ? "reject" : null,
    ].filter((decision): decision is string => decision !== null);
    if (decisions.length !== 1) {
      throw new Error("Choose exactly one of --accept, --request-changes, or --reject");
    }
    console.log(JSON.stringify(await (await connectedClient()).request(
      `/api/tasks/${encodeURIComponent(taskId)}/reviews`,
      { method: "POST", body: { decision: decisions[0], note: options.note } },
    ), null, 2));
  });
taskCommands.command("publish")
  .argument("<task-id>")
  .requiredOption("--confirm", "confirm this human-approved SCM write")
  .option("--branch <branch>", "safe target branch under mob/")
  .option("--message <message>", "commit message", "mob: publish reviewed task")
  .action(async (taskId: string, options: { confirm: boolean; branch?: string; message: string }) => {
    console.log(JSON.stringify(await (await connectedClient()).request(
      `/api/tasks/${encodeURIComponent(taskId)}/publications`,
      {
        method: "POST",
        body: {
          confirm: options.confirm,
          ...(options.branch ? { branch: options.branch } : {}),
          commitMessage: options.message,
        },
      },
    ), null, 2));
  });

const chatCommands = program.command("chat").description("send messages through the shared environment");
chatCommands.command("send")
  .argument("<task-id>")
  .argument("<message...>")
  .action(async (taskId: string, words: string[]) => {
    const content = words.join(" ").trim();
    if (!content) throw new Error("Message is required");
    const result = await (await connectedClient()).request(`/api/conversations/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content, invoke: false },
    });
    console.log(JSON.stringify(result, null, 2));
  });

const agentCommands = program.command("agent").description("invoke a named actor in the environment");
agentCommands.command("list").action(async () => {
  const response = await (await connectedClient()).request<AgentListResponse>("/api/agents");
  console.log(JSON.stringify(response.agents ?? [], null, 2));
});
agentCommands.command("add")
  .requiredOption("--handle <handle>", "stable @handle")
  .requiredOption("--name <name>", "display name")
  .requiredOption("--driver <driver>", "pi, omp, claude, codex, hermes, or deepseek")
  .option("--role <role>", "short collaboration role", "Coding collaborator")
  .option("--model <model>", "MobAI model ID; omit to use the harness default")
  .option("--skill <skill>", "skill reference (repeatable)", collectOption)
  .option("--plugin <plugin>", "installed shared plugin reference (repeatable)", collectOption)
  .option("--environment <reference>", "secret-free environment reference, for example railway:default")
  .action(async (options: AgentAddOptions) => {
    const modelId = optionalNonEmpty(options.model, "--model");
    const skillRefs = options.skill?.map((value) => requiredNonEmpty(value, "--skill"));
    const pluginRefs = options.plugin?.map((value) => requiredNonEmpty(value, "--plugin"));
    const environmentReference = optionalNonEmpty(options.environment, "--environment");
    console.log(JSON.stringify(await (await connectedClient()).request("/api/agents", {
      method: "POST",
      body: {
        handle: requiredNonEmpty(options.handle, "--handle"),
        name: requiredNonEmpty(options.name, "--name"),
        driver: requiredNonEmpty(options.driver, "--driver"),
        role: options.role,
        ...(modelId === undefined ? {} : { modelId }),
        ...(skillRefs === undefined ? {} : { skillRefs }),
        ...(pluginRefs === undefined ? {} : { pluginRefs }),
        ...(environmentReference === undefined
          ? {}
          : { environment: { reference: environmentReference, values: {} } }),
      },
    }), null, 2));
  });
agentCommands.command("configure")
  .description("update an Agent while preserving fields not named on this command")
  .argument("<agent>", "agent ID or @handle")
  .option("--name <name>", "display name")
  .option("--role <role>", "short collaboration role")
  .option("--driver <driver>", "pi, omp, claude, codex, hermes, or deepseek")
  .option("--model <model>", "MobAI model ID")
  .option("--default-model", "use the selected harness default model")
  .option("--skill <skill>", "replace skills with this reference (repeatable)", collectOption)
  .option("--clear-skills", "remove every configured skill reference")
  .option("--plugin <plugin>", "replace plugins with this installed shared reference (repeatable)", collectOption)
  .option("--clear-plugins", "remove every configured plugin reference")
  .option("--environment <reference>", "replace the secret-free environment reference")
  .option("--clear-environment", "remove the environment reference and safe values")
  .action(async (agent: string, options: AgentConfigureOptions) => {
    assertAgentConfigureOptions(options);
    const client = await connectedClient();
    const response = await client.request<AgentListResponse>("/api/agents");
    const current = findAgent(response.agents ?? [], agent);
    const driver = optionalNonEmpty(options.driver, "--driver") ?? current.driver ?? current.harness;
    if (!driver) throw new Error(`Agent '@${current.handle}' has no harness configuration`);

    const currentEnvironment = normalizeListedEnvironment(current.environment);
    const modelId = options.defaultModel
      ? null
      : optionalNonEmpty(options.model, "--model") ?? current.modelId ?? null;
    const skillRefs = options.clearSkills
      ? []
      : options.skill?.map((value) => requiredNonEmpty(value, "--skill")) ?? current.skillRefs ?? [];
    const pluginRefs = options.clearPlugins
      ? []
      : options.plugin?.map((value) => requiredNonEmpty(value, "--plugin")) ?? current.pluginRefs ?? [];
    const environment = options.clearEnvironment
      ? { reference: null, values: {} }
      : options.environment === undefined
        ? currentEnvironment
        : {
            reference: requiredNonEmpty(options.environment, "--environment"),
            values: {},
          };

    console.log(JSON.stringify(await client.request(`/api/agents/${encodeURIComponent(current.id)}`, {
      method: "PATCH",
      body: {
        name: optionalNonEmpty(options.name, "--name") ?? current.name,
        role: options.role === undefined ? current.role : options.role,
        driver,
        modelId,
        skillRefs,
        pluginRefs,
        environment,
      },
    }), null, 2));
  });
agentCommands.command("invoke")
  .argument("<task-id>")
  .argument("<agent>", "agent ID or @handle")
  .argument("<request...>")
  .action(async (taskId: string, agent: string, words: string[]) => {
    const client = await connectedClient();
    const response = await client.request<AgentListResponse>("/api/agents");
    const needle = agent.replace(/^@/u, "").toLowerCase();
    const matched = (response.agents ?? []).find((item) =>
      item.id === agent || item.handle?.toLowerCase() === needle || item.name?.toLowerCase() === needle,
    );
    if (!matched?.handle) throw new Error(`Agent '${agent}' was not found`);
    const content = words.join(" ").trim();
    if (!content) throw new Error("Agent instruction is required");
    const invoke = () => client.request(`/api/conversations/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content, invoke: true, agent: matched.id },
    });
    let result: unknown;
    try {
      result = await invoke();
    } catch (error) {
      if (!(error instanceof MobApiError) || error.status !== 409 || error.code !== "task_closed") throw error;
      await client.request(`/api/tasks/${encodeURIComponent(taskId)}/reviews`, {
        method: "POST",
        body: {
          decision: "request_changes",
          note: "Reopened by mob agent invoke for an explicit follow-up instruction.",
        },
      });
      result = await invoke();
    }
    console.log(JSON.stringify(result, null, 2));
  });

const modelCommands = program.command("model").description("discover models exposed by the connected Mob environment");
modelCommands.command("list").action(async () => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/models"), null, 2));
});

const capabilityCommands = program.command("capability").alias("catalog").description("inspect shared Skill, Plugin, and Environment files");
capabilityCommands.command("list").action(async () => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/capabilities/catalog"), null, 2));
});

const conversationCommands = program.command("conversation").alias("conversations").description("work with direct and group chats");
conversationCommands.command("list").action(async () => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/conversations"), null, 2));
});
conversationCommands.command("show").argument("<conversation-id>").action(async (conversationId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/conversations/${encodeURIComponent(conversationId)}`), null, 2));
});
conversationCommands.command("create")
  .argument("<task-id>")
  .requiredOption("--kind <kind>", "direct or group")
  .option("--title <title>", "group title")
  .option("--member <member...>", "Agent/human IDs or @handles")
  .action(async (taskId: string, options: { kind: string; title?: string; member?: string[] }) => {
    console.log(JSON.stringify(await (await connectedClient()).request("/api/conversations", {
      method: "POST",
      body: { taskId, kind: options.kind, title: options.title, members: options.member ?? [] },
    }), null, 2));
  });
conversationCommands.command("send")
  .argument("<conversation-id>")
  .argument("<message...>")
  .option("--invoke <agent>", "explicitly start one Agent member")
  .action(async (conversationId: string, words: string[], options: { invoke?: string }) => {
    const content = words.join(" ").trim();
    if (!content) throw new Error("Message is required");
    console.log(JSON.stringify(await (await connectedClient()).request(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: "POST", body: { content, invoke: Boolean(options.invoke), agent: options.invoke } },
    ), null, 2));
  });

const runCommands = program.command("run").description("observe and control agent runs");
runCommands.command("status").argument("<run-id>").action(async (runId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/runs/${encodeURIComponent(runId)}`), null, 2));
});
runCommands.command("cancel").argument("<run-id>").action(async (runId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }), null, 2));
});
for (const [name, type] of [["steer", "steer"], ["follow-up", "follow_up"]] as const) {
  runCommands.command(name)
    .argument("<run-id>")
    .argument("<message...>")
    .action(async (runId: string, words: string[]) => {
      const message = words.join(" ").trim();
      if (!message) throw new Error("Message is required");
      console.log(JSON.stringify(await (await connectedClient()).request(
        `/api/runs/${encodeURIComponent(runId)}/commands`,
        { method: "POST", body: { type, message } },
      ), null, 2));
    });
}
runCommands.command("watch")
  .argument("<run-id>")
  .option("--interval <milliseconds>", "poll interval", "1500")
  .action(async (runId: string, options: { interval: string }) => {
    const client = await connectedClient();
    const interval = Math.max(250, Math.min(30_000, Number(options.interval) || 1_500));
    let cursor = 0;
    for (;;) {
      const page = await client.request<{ cursor: number; events: unknown[] }>(`/api/runs/${encodeURIComponent(runId)}/events`, { query: { after: cursor } });
      for (const event of page.events) console.log(JSON.stringify(event));
      cursor = page.cursor;
      const status = await client.request<{ status: string }>(`/api/runs/${encodeURIComponent(runId)}`);
      if (["succeeded", "failed", "cancelled"].includes(status.status)) {
        console.log(JSON.stringify({ type: "run.status", status: status.status }));
        return;
      }
      await delay(interval);
    }
  });

const knowledgeCommands = program.command("knowledge").alias("wiki").description("read and maintain workspace knowledge files");
knowledgeCommands.command("list").option("--area <area>", "raw or wiki").action(async (options: { area?: string }) => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge", { query: { area: options.area } }), null, 2));
});
knowledgeCommands.command("search").argument("<query...>").action(async (words: string[]) => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/search", { query: { q: words.join(" ") } }), null, 2));
});
knowledgeCommands.command("retrieve").argument("<query...>").action(async (words: string[]) => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/retrieve", { query: { q: words.join(" ") } }), null, 2));
});
knowledgeCommands.command("ask").argument("<question...>").action(async (words: string[]) => {
  const question = words.join(" ").trim();
  if (!question) throw new Error("Question is required");
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/query", {
    query: { q: question },
  }), null, 2));
});
knowledgeCommands.command("read").argument("<path>").action(async (path: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/file", { query: { path } }), null, 2));
});
knowledgeCommands.command("add-raw").argument("<knowledge-path>").argument("<file>").action(async (path: string, file: string) => {
  const content = await readFile(file, "utf8");
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/raw", { method: "POST", body: { path, content, source: `cli:${basename(file)}` } }), null, 2));
});
knowledgeCommands.command("curate").argument("<knowledge-path>").argument("<file>").action(async (path: string, file: string) => {
  const content = await readFile(file, "utf8");
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/wiki", { method: "POST", body: { path, content, source: `cli:${basename(file)}` } }), null, 2));
});
knowledgeCommands.command("import-dir")
  .argument("<directory>")
  .requiredOption("--area <area>", "raw or wiki")
  .action(async (directory: string, options: { area: string }) => {
    if (options.area !== "raw" && options.area !== "wiki") {
      throw new Error("--area must be 'raw' or 'wiki'");
    }
    console.log(JSON.stringify(await importWikiDirectory(
      await connectedClient(),
      directory,
      options.area,
    ), null, 2));
  });
knowledgeCommands.command("lint").action(async () => {
  console.log(JSON.stringify(await (await connectedClient()).request("/api/knowledge/lint"), null, 2));
});

const db = program.command("db");
db.command("migrate").action(async () => {
  const config = loadConfig();
  const sql = createDatabaseClient(config.databaseUrl);
  try {
    await migrateDatabase(sql);
    console.log("Database migrations are current.");
  } finally {
    await sql.end();
  }
});
db.command("rebuild")
  .alias("replay")
  .description("validate or replay file-backed workspace state into PostgreSQL")
  .requiredOption("--workspace <workspace-id>", "workspace UUID under MOB_DATA_DIR/state/workspaces")
  .option("--apply", "apply the replay; without this flag the command is read-only")
  .option("--confirm <workspace-id>", "required with --apply and must exactly match --workspace")
  .action(async (options: { workspace: string; apply?: boolean; confirm?: string }) => {
    const config = loadConfig();
    if (options.apply && options.confirm !== options.workspace) {
      throw new Error(`Apply mode requires --confirm ${options.workspace}`);
    }
    const sql = createDatabaseClient(config.databaseUrl);
    try {
      // Validation must be genuinely read-only. Schema migration is allowed
      // only as part of the explicitly confirmed apply path.
      if (options.apply) await migrateDatabase(sql);
      const result = await replayWorkspaceProjection({
        sql,
        files: new FileWorkspaceStore({ dataDir: config.dataDir }),
        workspaceId: options.workspace,
        apply: options.apply ?? false,
        ...(options.confirm ? { confirmation: options.confirm } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 2;
    } finally {
      await sql.end();
    }
  });

program.command("context").description("print the current shared task context").action(async () => {
  const claims = readRunClaims();
  console.log(JSON.stringify(await api(`/api/tasks/${claims.taskId}`), null, 2));
});

program.command("say").argument("<message>").description("post a message to the shared task").action(async (message: string) => {
  const claims = readRunClaims();
  console.log(JSON.stringify(await api(`/api/tasks/${claims.taskId}/messages`, { method: "POST", body: JSON.stringify({ content: message }) }), null, 2));
});

program.command("delegate")
  .argument("<agent>", "agent UUID or @handle")
  .argument("<deliverable>")
  .option("--read-only", "do not request the task writer lease")
  .description("delegate a bounded deliverable to another agent")
  .action(async (agent: string, deliverable: string, options: { readOnly?: boolean }) => {
    const claims = readRunClaims();
    const agentId = agent.replace(/^@/u, "");
    console.log(JSON.stringify(await api(`/api/tasks/${claims.taskId}/delegations`, { method: "POST", body: JSON.stringify({ agentId, deliverable, writerRequired: !options.readOnly }) }), null, 2));
  });

const artifact = program.command("artifact");
artifact.command("add").argument("<path>").description("publish a file artifact").action(async (path: string) => {
  const claims = readRunClaims();
  const form = new FormData();
  const contents = await readFile(path);
  form.append("file", new Blob([contents]), basename(path));
  console.log(JSON.stringify(await api(`/api/tasks/${claims.taskId}/artifacts`, { method: "POST", body: form }), null, 2));
});

program.command("done").argument("<summary>").description("post the run's final summary").action(async (summary: string) => {
  const claims = readRunClaims();
  await api(`/api/tasks/${claims.taskId}/messages`, { method: "POST", body: JSON.stringify({ content: summary, kind: "result" }) });
  console.log("Summary posted.");
});

await program.parseAsync(process.argv);

async function createRuntime() {
  const config = loadConfig();
  const sql = createDatabaseClient(config.databaseUrl);
  await migrateDatabase(sql);
  const store = createCollaborationStore(sql);
  const files = new FileWorkspaceStore({ dataDir: config.dataDir });
  await ensureBootstrap(config, store, files);
  const drivers = createDefaultAgentDriverRegistry({
    mock: new MockDriver({
      delegate: async (input, context) => {
        context.emit({ kind: "message.delta", message: "Reading the shared task context…" });
        return {
          finalMessage: `I reviewed the shared task and completed this run.\n\nRequested work:\n${input.prompt.slice(0, 900)}`,
        };
      },
    }),
    pi: {
      extraArgs: ["--provider", "mob-ai", "--model", config.mobAiModel, "--approve"],
    },
    omp: {
      extraArgs: ["--model", `mob-ai/${config.mobAiModel}`, "--no-session"],
    },
  });
  const worker = new MobWorker({ id: `${hostname()}-${process.pid}`, store, files, drivers, config });
  return { config, sql, store, files, worker };
}

async function runServer(forceEmbedded: boolean): Promise<void> {
  const runtime = await createRuntime();
  const embedded = forceEmbedded && runtime.config.embeddedWorker;
  if (embedded) runtime.worker.start();
  const app = await buildApp({
    config: runtime.config,
    store: runtime.store,
    files: runtime.files,
    ...(embedded ? { worker: runtime.worker } : {}),
  });
  await app.listen({ host: runtime.config.host, port: runtime.config.port });
  console.log(`Mob Agent Crew listening on ${runtime.config.host}:${runtime.config.port}`);
  installShutdown(async () => {
    if (embedded) await runtime.worker.stop();
    await app.close();
    await runtime.sql.end();
  });
}

async function runWorker(): Promise<void> {
  const runtime = await createRuntime();
  runtime.worker.start();
  console.log("Mob Agent Crew worker started.");
  installShutdown(async () => {
    await runtime.worker.stop();
    await runtime.sql.end();
  });
}

function installShutdown(shutdown: () => Promise<void>): void {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

async function connectedClient(): Promise<MobApiClient> {
  if (process.env.MOB_RUN_TOKEN) {
    return new MobApiClient({
      server: process.env.MOB_API_URL ?? "http://127.0.0.1:4310",
      token: process.env.MOB_RUN_TOKEN,
    });
  }
  const config = await loadClientConfig();
  if (!config) throw new Error("Run 'mob login' first");
  return new MobApiClient(config);
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
}

function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function requiredNonEmpty(value: string, option: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${option} cannot be empty`);
  return normalized;
}

function optionalNonEmpty(value: string | undefined, option: string): string | undefined {
  return value === undefined ? undefined : requiredNonEmpty(value, option);
}

function assertAgentConfigureOptions(options: AgentConfigureOptions): void {
  if (options.model !== undefined && options.defaultModel) {
    throw new Error("Choose --model or --default-model, not both");
  }
  if (options.skill !== undefined && options.clearSkills) {
    throw new Error("Choose --skill or --clear-skills, not both");
  }
  if (options.plugin !== undefined && options.clearPlugins) {
    throw new Error("Choose --plugin or --clear-plugins, not both");
  }
  if (options.environment !== undefined && options.clearEnvironment) {
    throw new Error("Choose --environment or --clear-environment, not both");
  }
  if (
    options.name === undefined &&
    options.role === undefined &&
    options.driver === undefined &&
    options.model === undefined &&
    !options.defaultModel &&
    options.skill === undefined &&
    !options.clearSkills &&
    options.plugin === undefined &&
    !options.clearPlugins &&
    options.environment === undefined &&
    !options.clearEnvironment
  ) {
    throw new Error("Specify at least one Agent field to configure");
  }
}

function findAgent(agents: readonly ListedAgent[], requested: string): ListedAgent {
  const needle = requested.replace(/^@/u, "").toLowerCase();
  const matched = agents.find((agent) =>
    agent.id === requested || agent.handle.toLowerCase() === needle,
  );
  if (!matched) throw new Error(`Agent '${requested}' was not found`);
  return matched;
}

function normalizeListedEnvironment(environment: ListedAgent["environment"]): {
  reference: string | null;
  values: Record<string, string>;
} {
  return {
    reference: environment?.reference ?? null,
    values: environment?.values ?? {},
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readRunClaims(): { taskId: string } {
  const token = process.env.MOB_RUN_TOKEN;
  if (!token) throw new Error("MOB_RUN_TOKEN is required inside an agent run");
  const encoded = token.split(".")[0];
  if (!encoded) throw new Error("MOB_RUN_TOKEN is malformed");
  const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { taskId?: string };
  if (!raw.taskId) throw new Error("MOB_RUN_TOKEN does not contain a task scope");
  return { taskId: raw.taskId };
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = process.env.MOB_RUN_TOKEN;
  const base = process.env.MOB_API_URL ?? "http://127.0.0.1:4310";
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, base), { ...init, headers });
  if (!response.ok) throw new Error(`Mob API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
