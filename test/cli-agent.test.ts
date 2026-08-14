import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("mob agent CLI", () => {
  it("keeps chat separate from execution on the primary conversation", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { message: { id: "message-1" }, runs: [] });
    });

    await runCli(server, ["chat", "send", "task-1", "@builder", "context only"]);

    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: "/api/conversations/task-1/messages",
      body: { content: "@builder context only", invoke: false },
    })]);
  });

  it("uses an explicit primary-conversation invocation instead of implicit mention side effects", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      if (recorded.method === "GET") {
        replyJson(response, { agents: [{ id: "agent-1", handle: "builder", name: "Builder", role: "Builder" }] });
      } else {
        replyJson(response, { message: { id: "message-1" }, runs: [{ id: "run-1" }] });
      }
    });

    await runCli(server, ["agent", "invoke", "task-1", "@builder", "inspect", "this"]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/agents" }),
      expect.objectContaining({
        method: "POST",
        path: "/api/conversations/task-1/messages",
        body: { content: "inspect this", invoke: true, agent: "agent-1" },
      }),
    ]);
  });

  it("reopens a closed task once before retrying an explicit Agent invocation", async () => {
    const requests: RecordedRequest[] = [];
    let invocationCount = 0;
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      if (recorded.method === "GET") {
        replyJson(response, { agents: [{ id: "agent-1", handle: "builder", name: "Builder", role: "Builder" }] });
        return;
      }
      if (recorded.path === "/api/conversations/task-1/messages" && invocationCount++ === 0) {
        replyJson(
          response,
          { error: "task_closed", message: "Request changes before starting another Agent run." },
          409,
        );
        return;
      }
      replyJson(response, recorded.path.endsWith("/reviews")
        ? { task: { id: "task-1", status: "open" } }
        : { message: { id: "message-1" }, runs: [{ id: "run-1" }] });
    });

    await runCli(server, ["agent", "invoke", "task-1", "@builder", "continue", "carefully"]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/agents" }),
      expect.objectContaining({ method: "POST", path: "/api/conversations/task-1/messages" }),
      expect.objectContaining({
        method: "POST",
        path: "/api/tasks/task-1/reviews",
        body: {
          decision: "request_changes",
          note: "Reopened by mob agent invoke for an explicit follow-up instruction.",
        },
      }),
      expect.objectContaining({
        method: "POST",
        path: "/api/conversations/task-1/messages",
        body: { content: "continue carefully", invoke: true, agent: "agent-1" },
      }),
    ]);
  });

  it("lists the canonical agent composition endpoint", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { agents: [{ id: "agent-1", handle: "builder" }] });
    });

    const result = await runCli(server, ["agent", "list"]);

    expect(requests).toEqual([expect.objectContaining({ method: "GET", path: "/api/agents" })]);
    expect(JSON.parse(result.stdout)).toEqual([{ id: "agent-1", handle: "builder" }]);
  });

  it("adds model, repeatable skills, and an environment reference without value flags", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { id: "agent-2", handle: "reviewer" });
    });

    await runCli(server, [
      "agent", "add",
      "--handle", "reviewer",
      "--name", "Reviewer",
      "--driver", "hermes",
      "--model", "deepseek-v4-pro",
      "--skill", "review:typescript",
      "--skill", "workflow:focused-tests",
      "--environment", "railway:engineering",
    ]);

    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: "/api/agents",
      body: {
        handle: "reviewer",
        name: "Reviewer",
        driver: "hermes",
        role: "Coding collaborator",
        modelId: "deepseek-v4-pro",
        skillRefs: ["review:typescript", "workflow:focused-tests"],
        environment: { reference: "railway:engineering", values: {} },
      },
    })]);
  });

  it("configures by @handle while preserving fields that were not supplied", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      if (recorded.method === "GET") {
        replyJson(response, {
          agents: [{
            id: "agent-1",
            handle: "builder",
            name: "Builder",
            role: "Implementation owner",
            driver: "pi",
            modelId: "deepseek-v4-flash",
            skillRefs: ["code:typescript"],
            environment: { reference: "railway:default", values: { MODE: "focused" } },
          }],
        });
        return;
      }
      replyJson(response, { id: "agent-1", handle: "builder" });
    });

    await runCli(server, [
      "agent", "configure", "@builder",
      "--name", "Build Captain",
      "--driver", "codex",
      "--default-model",
      "--clear-skills",
      "--environment", "railway:engineering",
    ]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/agents" }),
      expect.objectContaining({
        method: "PATCH",
        path: "/api/agents/agent-1",
        body: {
          name: "Build Captain",
          role: "Implementation owner",
          driver: "codex",
          modelId: null,
          skillRefs: [],
          environment: { reference: "railway:engineering", values: {} },
        },
      }),
    ]);
  });

  it("rejects mutually exclusive configure flags before connecting", async () => {
    await expect(runCli("http://127.0.0.1:1", [
      "agent", "configure", "@builder", "--model", "deepseek-v4-pro", "--default-model",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Choose --model or --default-model, not both"),
    });
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function record(request: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    ...(rawBody ? { body: JSON.parse(rawBody) as unknown } : {}),
  };
}

function replyJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function runCli(server: string, arguments_: string[]) {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...arguments_], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOB_API_URL: server,
      MOB_RUN_TOKEN: "test-run-token",
    },
  });
}
