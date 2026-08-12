import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMobAiProviderConfig } from "../../src/agents/mob-ai-config.js";

const directories: string[] = [];

afterEach(async () => {
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
});
