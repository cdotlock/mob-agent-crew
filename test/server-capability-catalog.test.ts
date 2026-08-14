import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../src/auth/tokens.js";
import type { AppConfig } from "../src/config.js";
import type { CollaborationStore } from "../src/db/store.js";
import { buildApp } from "../src/server/app.js";
import type { FileWorkspaceStore } from "../src/storage/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "capability-catalog-secret-longer-than-thirty-two";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("capability catalog API", () => {
  it("lists built-ins and persists human-managed secret-free catalog entries", async () => {
    const fixture = await createFixture();
    const initial = await fixture.app.inject({
      method: "GET",
      url: "/api/capabilities/catalog",
      headers: fixture.headers,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      version: 1,
      workspaceId: WORKSPACE_ID,
      skills: expect.arrayContaining([expect.objectContaining({ id: "mob:repository-knowledge" })]),
      environments: expect.arrayContaining([expect.objectContaining({ id: "railway:default" })]),
    });

    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/capabilities/catalog/skills",
      headers: fixture.headers,
      payload: {
        id: "team:release-review",
        name: "Release review",
        description: "Shared release checks",
        instructions: "Review the requested release and report concrete evidence.",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      capability: { kind: "skill", id: "team:release-review", source: "workspace", status: "available" },
    });

    const refreshed = await fixture.app.inject({
      method: "GET",
      url: "/api/capabilities/catalog",
      headers: fixture.headers,
    });
    expect(refreshed.json().skills).toContainEqual(expect.objectContaining({ id: "team:release-review" }));
  });

  it("rejects executable fields, forged plugin installation and credentials", async () => {
    const fixture = await createFixture();
    const executable = await fixture.app.inject({
      method: "POST",
      url: "/api/capabilities/catalog/plugins",
      headers: fixture.headers,
      payload: {
        id: "team:unsafe-code",
        name: "Unsafe code",
        compatibleDrivers: ["pi"],
        executablePath: "/tmp/plugin.js",
      },
    });
    expect(executable.statusCode).toBe(400);

    const forged = await fixture.app.inject({
      method: "POST",
      url: "/api/capabilities/catalog/plugins",
      headers: fixture.headers,
      payload: {
        id: "team:fake-installed",
        name: "Fake installed",
        status: "installed",
        compatibleDrivers: ["pi"],
      },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json()).toMatchObject({ error: "plugin_installation_control_required" });

    const credential = await fixture.app.inject({
      method: "POST",
      url: "/api/capabilities/catalog/environments",
      headers: fixture.headers,
      payload: {
        id: "team:unsafe",
        name: "Unsafe",
        values: { API_KEY: "plain" },
      },
    });
    expect(credential.statusCode).toBe(409);
    expect(credential.json()).toMatchObject({ error: "secret_environment_key_forbidden" });
  });
});

async function createFixture(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  headers: { authorization: string };
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "mob-capability-api-"));
  const workspaceRoot = join(dataDir, "state", "workspaces", WORKSPACE_ID);
  const app = await buildApp({
    config: config(dataDir),
    store: {} as CollaborationStore,
    files: { workspaceRoot: () => workspaceRoot } as unknown as FileWorkspaceStore,
  });
  cleanups.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    app,
    headers: {
      authorization: `Bearer ${issueSessionToken({ actorId: HUMAN_ID, workspaceId: WORKSPACE_ID }, SECRET)}`,
    },
  };
}

function config(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    databaseUrl: "postgres://unused",
    host: "127.0.0.1",
    port: 4310,
    dataDir,
    embeddedWorker: false,
    workerConcurrency: 1,
    enableMockDriver: false,
    sessionSecret: SECRET,
    adminName: "Test",
    bootstrapRepositoryUrl: "https://github.com/example/repository",
    mobAiBaseUrl: "https://example.test/api",
    mobAiModel: "test-model",
  };
}
