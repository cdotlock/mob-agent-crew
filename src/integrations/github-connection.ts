export interface GitHubConnectionStatus {
  readonly configured: boolean;
  readonly variable: "GH_TOKEN";
  readonly setup: {
    readonly railway: "railway variable set GH_TOKEN --stdin --skip-deploys";
    readonly verify: "gh auth status --hostname github.com";
    readonly note: string;
  };
}

/**
 * Detect a non-empty control-plane credential input. The token file contents
 * are intentionally never opened, read, copied, or returned.
 */
export function isGitHubCliConfigured(environment: NodeJS.ProcessEnv): boolean {
  if (environment.GH_TOKEN?.trim()) return true;
  const tokenFile = environment.GH_TOKEN_FILE?.trim();
  if (!tokenFile) return false;
  try {
    const info = lstatSync(tokenFile);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function githubConnectionStatus(configured: boolean): GitHubConnectionStatus {
  return {
    configured,
    variable: "GH_TOKEN",
    setup: {
      railway: "railway variable set GH_TOKEN --stdin --skip-deploys",
      verify: "gh auth status --hostname github.com",
      note: "Use a repository-scoped token. Pass it on standard input; never paste it into chat, Wiki, a URL, or a command argument.",
    },
  };
}
import { lstatSync } from "node:fs";
