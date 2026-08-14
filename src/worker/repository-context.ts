export interface TaskRepositoryRow {
  repositoryId: string | null;
  name: string | null;
  remoteUrl: string | null;
  baseRevision: string | null;
  allowlisted: boolean | null;
  enabled: boolean | null;
}

export type TaskRepositoryContext =
  | { kind: "scratch" }
  | {
      kind: "git";
      repositoryId: string;
      name: string;
      remoteUrl: string;
      baseRevision: string;
    };

/**
 * Turns the nullable task/repository join into the worker's only two runtime
 * modes. A missing repository is a valid conversation workspace, while an
 * explicitly selected repository must still satisfy the existing trust gate.
 */
export function taskRepositoryContext(
  row: TaskRepositoryRow | undefined,
): TaskRepositoryContext {
  if (!row) throw new Error("Task repository context was not found");
  if (!row.repositoryId) return { kind: "scratch" };
  if (!row.allowlisted || !row.enabled || !row.remoteUrl?.trim()) {
    throw new Error("Task repository is not an enabled allowlisted Git remote");
  }
  const name = row.name?.trim();
  const baseRevision = row.baseRevision?.trim();
  if (!name || !baseRevision) {
    throw new Error("Task repository context is incomplete");
  }
  return {
    kind: "git",
    repositoryId: row.repositoryId,
    name,
    remoteUrl: row.remoteUrl.trim(),
    baseRevision,
  };
}
