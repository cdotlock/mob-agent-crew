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
  it("presents conversation-first help without task or invoke requirements", async () => {
    const topLevel = await runCli("http://127.0.0.1:1", ["--help"]);
    const chat = await runCli("http://127.0.0.1:1", ["chat", "--help"]);

    expect(topLevel.stdout).toContain("Conversation-first collaboration");
    expect(topLevel.stdout).toContain("chat|conversation");
    expect(topLevel.stdout).toContain("legacy execution review and publication administration");
    expect(chat.stdout).toContain("new|create");
    expect(chat.stdout).toContain("send [options] <conversation-id> <message...>");
    expect(chat.stdout).not.toContain("task-id");
    expect(chat.stdout).not.toContain("--invoke");
  });

  it("lists conversations as the primary chat surface", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { conversations: [{ id: "conversation-1", kind: "group" }] });
    });

    const result = await runCli(server, ["chat", "list"]);

    expect(requests).toEqual([expect.objectContaining({ method: "GET", path: "/api/conversations" })]);
    expect(JSON.parse(result.stdout)).toMatchObject({ conversations: [{ id: "conversation-1" }] });
  });

  it("creates a repository-optional conversation without a task", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { conversation: { id: "conversation-1", kind: "direct" } });
    });

    await runCli(server, [
      "chat", "new", "--kind", "direct", "--member", "@builder", "--repository", "repository-1",
    ]);

    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: "/api/conversations",
      body: {
        kind: "direct",
        members: ["@builder"],
        activeRepositoryId: "repository-1",
      },
    })]);
  });

  it("sends semantic chat without task or invoke flags", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { message: { id: "message-1" }, deliveries: [{ action: "queued_run" }] });
    });

    await runCli(server, [
      "chat", "send", "conversation-1", "@builder", "先看看问题，必要时再开始长程工作",
      "--repository", "repository-2",
    ]);

    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: "/api/conversations/conversation-1/messages",
      body: {
        content: "@builder 先看看问题，必要时再开始长程工作",
        repositoryId: "repository-2",
      },
    })]);
  });

  it("keeps conversation create as a compatibility alias for chat new", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { conversation: { id: "conversation-2", kind: "group" } });
    });

    await runCli(server, [
      "conversation", "create", "--kind", "group", "--title", "Release", "--member", "@builder", "@reviewer",
    ]);

    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: "/api/conversations",
      body: { kind: "group", title: "Release", members: ["@builder", "@reviewer"] },
    })]);
  });

  it("translates the old conversation invoke option into an ordinary @mention", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      if (recorded.method === "GET") {
        replyJson(response, { agents: [{ id: "agent-1", handle: "builder", name: "Builder", role: "Builder" }] });
      } else {
        replyJson(response, { message: { id: "message-1" } });
      }
    });

    await runCli(server, [
      "conversation", "send", "conversation-1", "--invoke", "agent-1", "review", "this",
    ]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/agents" }),
      expect.objectContaining({
        method: "POST",
        path: "/api/conversations/conversation-1/messages",
        body: { content: "@builder review this" },
      }),
    ]);
  });

  it("keeps the old hidden agent invoke command as a semantic-chat bridge", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      if (recorded.method === "GET") {
        replyJson(response, { agents: [{ id: "agent-1", handle: "builder", name: "Builder", role: "Builder" }] });
      } else {
        replyJson(response, { message: { id: "message-1" } });
      }
    });

    await runCli(server, ["agent", "invoke", "conversation-1", "@builder", "inspect", "this"]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/agents" }),
      expect.objectContaining({
        method: "POST",
        path: "/api/conversations/conversation-1/messages",
        body: { content: "@builder inspect this" },
      }),
    ]);
  });

  it("lists, imports, and selects repositories independently of chat creation", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      const recorded = await record(request);
      requests.push(recorded);
      replyJson(response, { ok: true });
    });

    await runCli(server, ["repo", "list"]);
    await runCli(server, ["repo", "import", "https://github.com/cdotlock/mob-agent-crew"]);
    await runCli(server, ["repo", "use", "conversation-1", "repository-1"]);

    expect(requests).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/repositories" }),
      expect.objectContaining({
        method: "POST",
        path: "/api/repositories/import",
        body: { url: "https://github.com/cdotlock/mob-agent-crew" },
      }),
      expect.objectContaining({
        method: "PATCH",
        path: "/api/conversations/conversation-1",
        body: { activeRepositoryId: "repository-1" },
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
        role: "Team collaborator",
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
            pluginRefs: ["mob:deepseek-harness"],
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
          pluginRefs: ["mob:deepseek-harness"],
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

  it("lists the shared capability catalog", async () => {
    const requests: RecordedRequest[] = [];
    const server = await listen(async (request, response) => {
      requests.push(await record(request));
      replyJson(response, { version: 1, skills: [], plugins: [], environments: [] });
    });

    const result = await runCli(server, ["capability", "list"]);

    expect(requests).toEqual([expect.objectContaining({ method: "GET", path: "/api/capabilities/catalog" })]);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1 });
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
