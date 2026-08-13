import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, migrateDatabase } from "../../src/db/index.js";
import { CollaborationStore } from "../../src/db/store.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("conversation listing against PostgreSQL", () => {
  const sql = databaseUrl ? createDatabaseClient(databaseUrl, { max: 1 }) : null;
  const workspaceSlugSeed = randomUUID();
  const handleSeed = workspaceSlugSeed.replaceAll("-", "").slice(0, 16);
  let workspaceId = "";
  let humanId = "";
  let agentId = "";

  beforeAll(async () => {
    if (!sql) return;
    await migrateDatabase(sql);
    const store = new CollaborationStore(sql);
    const bootstrapped = await store.bootstrap({
      name: "Conversation list test",
      slug: `conversation-a${handleSeed}`,
      owner: {
        handle: `human-a${handleSeed}`,
        displayName: "Human",
        provider: "test",
        subject: `subject-${workspaceSlugSeed}`,
      },
    });
    workspaceId = bootstrapped.workspace.id;
    humanId = bootstrapped.owner.id;
    agentId = (await store.createActor({
      workspaceId,
      kind: "agent",
      handle: `agent-a${handleSeed}`,
      displayName: "Agent",
    })).id;
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    if (workspaceId) await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql.end();
  }, 30_000);

  it("uses a uuid array when fetching memberships and last messages", async () => {
    if (!sql) return;
    const store = new CollaborationStore(sql);
    const conversation = await store.createConversation({
      workspaceId,
      taskId: await createTask(store, workspaceId, humanId),
      createdByActorId: humanId,
      kind: "direct",
      memberActorIds: [agentId],
    });

    await store.createConversationMessage({
      conversationId: conversation.conversation.id,
      actorId: humanId,
      kind: "comment",
      body: "Run the smoke test",
    });

    const listed = await store.listConversations(conversation.conversation.workspaceId, humanId);
    const listedDirect = listed.find(
      (entry) => entry.conversation.id === conversation.conversation.id,
    );
    expect(listedDirect?.lastMessage?.body).toBe("Run the smoke test");
  }, 30_000);
});

async function createTask(
  store: CollaborationStore,
  workspaceId: string,
  actorId: string,
): Promise<string> {
  const repository = await store.createRepository({
    workspaceId,
    name: `repository-${workspaceId}`,
    kind: "git",
    remoteUrl: "https://github.com/cdotlock/mob-agent-crew",
    defaultBranch: "main",
    createdByActorId: actorId,
  });
  return (await store.createTask({
    workspaceId,
    repositoryId: repository.id,
    createdByActorId: actorId,
    title: "Conversation list test",
    description: "Exercise real PostgreSQL UUID array semantics.",
    baseRevision: "main",
  })).id;
}
