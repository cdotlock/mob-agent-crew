import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../../src/auth/tokens.js";
import type { AppConfig } from "../../src/config.js";
import type { CollaborationStore } from "../../src/db/store.js";
import { buildApp } from "../../src/server/app.js";
import type { FileWorkspaceStore } from "../../src/storage/index.js";

const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "github-status-test-secret-longer-than-thirty-two";
const temporaryDirectories: string[] = [];
const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GitHub integration route", () => {
  it("requires a human session and returns only safe setup metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mob-github-status-"));
    temporaryDirectories.push(dataDir);
    const app = await buildApp({
      config: testConfig(dataDir),
      store: {} as CollaborationStore,
      files: {} as FileWorkspaceStore,
    });
    apps.push(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/integrations/github/status",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/github/status",
      headers: {
        authorization: `Bearer ${issueSessionToken({ actorId: ACTOR_ID, workspaceId: WORKSPACE_ID }, SECRET)}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      variable: "GH_TOKEN",
      setup: {
        railway: "railway variable set GH_TOKEN --stdin --skip-deploys",
        verify: "gh auth status --hostname github.com",
        note: expect.stringContaining("standard input"),
      },
    });
    expect(response.body).not.toMatch(/github_pat_|ghp_|Bearer\s/iu);
  });
});

function testConfig(dataDir: string): AppConfig {
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
    githubCliConfigured: true,
  };
}
