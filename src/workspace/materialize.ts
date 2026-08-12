import { execFile } from "node:child_process";
import { access, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MaterializeWorkspaceInput {
  taskDirectory: string;
  remoteUrl: string;
  baseRevision: string;
}

export async function materializeGitWorkspace(input: MaterializeWorkspaceInput): Promise<void> {
  const gitDirectory = join(input.taskDirectory, ".git");
  if (await exists(gitDirectory)) return;

  await mkdir(dirname(input.taskDirectory), { recursive: true });
  if (await exists(input.taskDirectory)) {
    const entries = await readdir(input.taskDirectory);
    if (entries.length > 0) {
      throw new Error("Task workspace is non-empty but is not a Git checkout");
    }
  }

  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--no-tags", "--branch", input.baseRevision, "--", input.remoteUrl, input.taskDirectory],
    {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
