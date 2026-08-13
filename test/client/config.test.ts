import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearClientConfig,
  loadClientConfig,
  resolveClientConfigPath,
  saveClientConfig,
} from "../../src/client/config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mob-client-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Mob client configuration", () => {
  it("supports explicit, environment, XDG, and home-directory paths", () => {
    expect(
      resolveClientConfigPath({ configPath: "./credentials.json", cwd: "/work/project" }),
    ).toBe("/work/project/credentials.json");

    expect(
      resolveClientConfigPath({
        environment: { MOB_CONFIG_PATH: "./mob.json" },
        cwd: "/work/project",
      }),
    ).toBe("/work/project/mob.json");

    expect(
      resolveClientConfigPath({
        environment: { XDG_CONFIG_HOME: "/var/config" },
        homeDir: "/unused",
      }),
    ).toBe("/var/config/mob/config.json");

    expect(resolveClientConfigPath({ environment: {}, homeDir: "/home/clock" })).toBe(
      "/home/clock/.config/mob/config.json",
    );
  });

  it("atomically stores normalized server credentials with mode 0600", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "nested", "client.json");

    await saveClientConfig(
      { server: "https://mob.example.test/workspace/", token: "first-secret" },
      { configPath },
    );
    await saveClientConfig(
      { server: "https://mob.example.test/workspace", token: "second-secret" },
      { configPath },
    );

    expect(await loadClientConfig({ configPath })).toEqual({
      server: "https://mob.example.test/workspace",
      token: "second-secret",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      server: "https://mob.example.test/workspace",
      token: "second-secret",
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, "nested"))).toEqual(["client.json"]);
  });

  it("loads a missing file as null and clears an existing file", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "client.json");

    expect(await loadClientConfig({ configPath })).toBeNull();
    expect(await clearClientConfig({ configPath })).toBe(false);

    await saveClientConfig({ server: "http://127.0.0.1:4310", token: "secret" }, { configPath });
    expect(await clearClientConfig({ configPath })).toBe(true);
    expect(await clearClientConfig({ configPath })).toBe(false);
    expect(await loadClientConfig({ configPath })).toBeNull();
  });

  it("rejects malformed persisted credentials without revealing the token", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "client.json");
    const secret = "do-not-print-this-token";
    await writeFile(configPath, JSON.stringify({ server: "file:///tmp/mob", token: secret }));

    let error: unknown;
    try {
      await loadClientConfig({ configPath });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Invalid Mob client configuration");
    expect((error as Error).message).not.toContain(secret);
  });
});
