import { basename } from "node:path";
import { z } from "zod";

const githubRepositorySchema = z
  .string()
  .url()
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "https:" && url.hostname === "github.com", {
    message: "Only HTTPS GitHub repository URLs are supported",
  });

export type GitHubRepositoryImport = {
  url: string;
  owner: string;
  repository: string;
  slug: string;
};

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryImport {
  const url = githubRepositorySchema.parse(value.trim());
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("GitHub URL must point to a repository root");
  }

  const [owner, rawRepository] = segments;
  if (!owner || !rawRepository) {
    throw new Error("GitHub URL must include an owner and repository");
  }

  const repository = rawRepository.replace(/\.git$/u, "");
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GitHub owner or repository contains unsupported characters");
  }

  return {
    url: `https://github.com/${owner}/${repository}`,
    owner,
    repository,
    slug: `${owner}/${repository}`,
  };
}

export type MarkdownImport = {
  filename: string;
  title: string;
  content: string;
  bytes: number;
};

export function parseMarkdownImport(
  filename: string,
  content: string,
  maxBytes = 1_000_000,
): MarkdownImport {
  const safeFilename = basename(filename.trim());
  if (!safeFilename || !safeFilename.toLowerCase().endsWith(".md")) {
    throw new Error("Only .md documents are supported");
  }

  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\0", "").trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) {
    throw new Error("Markdown document is empty");
  }
  if (bytes > maxBytes) {
    throw new Error(`Markdown document exceeds ${maxBytes} bytes`);
  }

  const heading = normalized.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const fallbackTitle = safeFilename.replace(/\.md$/iu, "").replaceAll(/[-_]+/gu, " ");

  return {
    filename: safeFilename,
    title: heading || fallbackTitle,
    content: normalized,
    bytes,
  };
}
