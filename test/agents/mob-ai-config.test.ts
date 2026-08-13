import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMobAiProviderConfig } from "../../src/agents/mob-ai-config.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MobAI provider configuration", () => {
  it("overrides the OpenAI SDK user agent that MobAI blocks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-ai-config-"));
    directories.push(directory);
    await writeMobAiProviderConfig({ directory, baseUrl: "https://ai.mob-ai.cn/api", model: "deepseek-v4-pro" });
    const config = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    expect(config.providers["mob-ai"].headers["User-Agent"]).toBe("mob-agent-crew/0.1");
  });

  it("writes a secret-free Hermes custom-provider profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-ai-hermes-config-"));
    directories.push(directory);
    await writeMobAiProviderConfig({
      directory,
      baseUrl: "https://ai.mob-ai.cn/api/",
      model: "deepseek-v4-pro",
    });

    const config = await readFile(join(directory, "config.yaml"), "utf8");
    expect(config).toContain("provider: mob-ai");
    expect(config).toContain('api: "https://ai.mob-ai.cn/api/v1"');
    expect(config).toContain("key_env: MOB_AI_KEY");
    expect(config).toContain('default_model: "deepseek-v4-pro"');
    expect(config).toContain("User-Agent: mob-agent-crew/0.1");
    expect(config).not.toMatch(/^\s+api_key:/mu);
  });

  it("writes a secret-free Codex Responses provider profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-ai-codex-config-"));
    directories.push(directory);
    const secret = "mob-secret-that-must-never-be-written";
    vi.stubEnv("MOB_AI_KEY", secret);

    await writeMobAiProviderConfig({
      directory,
      baseUrl: "https://ai.mob-ai.cn/api/",
      model: "deepseek-v4-pro",
      codexModel: "gpt-5.6-sol",
    });

    const config = await readFile(join(directory, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain('model_provider = "mob_ai"');
    expect(config).toContain("[model_providers.mob_ai]");
    expect(config).toContain('base_url = "https://ai.mob-ai.cn/api/v1"');
    expect(config).toContain('env_key = "MOB_AI_KEY"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain("requires_openai_auth = false");
    expect(config).not.toContain(secret);
  });

  it("points every bundled CLI at the local run-token proxy with readable secret-free files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-ai-proxy-config-"));
    directories.push(directory);
    await writeMobAiProviderConfig({
      directory,
      baseUrl: "http://127.0.0.1:4310/api/provider",
      model: "deepseek-v4-pro",
      codexModel: "gpt-5.6-sol",
    });

    for (const filename of ["models.json", "models.yml", "config.yaml", "config.toml"]) {
      const config = await readFile(join(directory, filename), "utf8");
      expect(config).toContain("http://127.0.0.1:4310/api/provider/v1");
      expect(config).not.toContain("mob-security-regression-secret");
      expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o644);
    }
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
  });

  it("rejects a persisted symbolic-link Agent profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-ai-profile-link-"));
    directories.push(root);
    const target = join(root, "target");
    const profile = join(root, "profile");
    await mkdir(target);
    await symlink(target, profile);

    await expect(writeMobAiProviderConfig({
      directory: profile,
      baseUrl: "http://127.0.0.1:4310/api/provider",
      model: "deepseek-v4-pro",
    })).rejects.toThrow("symbolic link");
  });

  it("atomically replaces a persisted provider-file symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mob-ai-file-link-"));
    directories.push(directory);
    const outside = join(directory, "..", `${Date.now()}-outside.txt`);
    await writeFile(outside, "must remain unchanged\n");
    await symlink(outside, join(directory, "models.json"));
    try {
      await writeMobAiProviderConfig({
        directory,
        baseUrl: "http://127.0.0.1:4310/api/provider",
        model: "deepseek-v4-pro",
      });
      expect(await readFile(outside, "utf8")).toBe("must remain unchanged\n");
      expect((await lstat(join(directory, "models.json"))).isSymbolicLink()).toBe(false);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
