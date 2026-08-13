import type { CollaborationStore } from "../db/store.js";
import type { Workspace } from "../domain/model.js";
import type { FileWorkspaceStore } from "./file-workspace-store.js";

export async function writeTaskFileState(
  store: CollaborationStore,
  files: FileWorkspaceStore,
  taskId: string,
): Promise<void> {
  await files.repairTaskThread(await store.getTaskThread(taskId));
}

export async function writeWorkspaceFileState(
  store: CollaborationStore,
  files: FileWorkspaceStore,
  workspace: Workspace,
): Promise<void> {
  const [actors, agentProfiles, repositories, documents, tasks] = await Promise.all([
    store.listActors(workspace.id),
    store.listAgentProfiles(workspace.id),
    store.listRepositories(workspace.id),
    store.listWorkspaceDocuments(workspace.id),
    store.listTasks(workspace.id, 500),
  ]);
  await files.writeWorkspace(workspace);
  await Promise.all([
    ...actors.map((actor) => files.writeActor(actor)),
    ...agentProfiles.map((profile) => files.writeAgentProfile(profile)),
    ...repositories.map((repository) => files.writeRepository(repository)),
    ...documents.map((document) => files.writeDocument(document)),
  ]);
  for (const task of tasks) {
    await writeTaskFileState(store, files, task.id);
  }
}
