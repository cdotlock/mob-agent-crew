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
import { FileWorkspaceStore } from "./storage/index.js";
import {
  MobApiClient,
  clearClientConfig,
  loadClientConfig,
  normalizeServerUrl,
  saveClientConfig,
} from "./client/index.js";

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

const chatCommands = program.command("chat").description("send messages through the shared environment");
chatCommands.command("send")
  .argument("<task-id>")
  .argument("<message...>")
  .action(async (taskId: string, words: string[]) => {
    const content = words.join(" ").trim();
    if (!content) throw new Error("Message is required");
    const result = await (await connectedClient()).request(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content },
    });
    console.log(JSON.stringify(result, null, 2));
  });

const agentCommands = program.command("agent").description("invoke a named actor in the environment");
agentCommands.command("invoke")
  .argument("<task-id>")
  .argument("<agent>", "agent ID or @handle")
  .argument("<request...>")
  .action(async (taskId: string, agent: string, words: string[]) => {
    const client = await connectedClient();
    const bootstrap = await client.request<{ agents?: Array<{ id?: string; handle?: string; name?: string }> }>("/api/bootstrap");
    const needle = agent.replace(/^@/u, "").toLowerCase();
    const matched = (bootstrap.agents ?? []).find((item) =>
      item.id === agent || item.handle?.toLowerCase() === needle || item.name?.toLowerCase() === needle,
    );
    if (!matched?.handle) throw new Error(`Agent '${agent}' was not found`);
    const content = `@${matched.handle} ${words.join(" ").trim()}`.trim();
    const result = await client.request(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content },
    });
    console.log(JSON.stringify(result, null, 2));
  });

const runCommands = program.command("run").description("observe and control agent runs");
runCommands.command("status").argument("<run-id>").action(async (runId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/runs/${encodeURIComponent(runId)}`), null, 2));
});
runCommands.command("cancel").argument("<run-id>").action(async (runId: string) => {
  console.log(JSON.stringify(await (await connectedClient()).request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }), null, 2));
});
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
