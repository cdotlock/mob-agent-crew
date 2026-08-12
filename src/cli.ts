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

const program = new Command()
  .name("mob")
  .description("Shared collaboration for humans and CLI coding agents")
  .version("0.1.0");

program.command("start").description("start the web app and embedded worker").action(() => runServer(true));
program.command("serve").description("start the web app without a worker").action(() => runServer(false));
program.command("worker").description("start a worker process").action(runWorker);

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
  .argument("<agent>", "agent UUID")
  .argument("<deliverable>")
  .description("delegate a bounded deliverable to another agent")
  .action(async (agent: string, deliverable: string) => {
    const claims = readRunClaims();
    const agentId = agent.replace(/^@/u, "");
    console.log(JSON.stringify(await api(`/api/tasks/${claims.taskId}/delegations`, { method: "POST", body: JSON.stringify({ agentId, deliverable }) }), null, 2));
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
  await ensureBootstrap(config, store);
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
  const worker = new MobWorker({ id: `${hostname()}-${process.pid}`, store, drivers, config });
  return { config, sql, store, worker };
}

async function runServer(forceEmbedded: boolean): Promise<void> {
  const runtime = await createRuntime();
  const embedded = forceEmbedded && runtime.config.embeddedWorker;
  if (embedded) runtime.worker.start();
  const app = await buildApp({
    config: runtime.config,
    store: runtime.store,
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
