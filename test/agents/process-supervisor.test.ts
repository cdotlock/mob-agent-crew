import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSupervisedProcess } from "../../src/agents/index.js";

describe("process supervision", () => {
  it("escalates cancellation for an uncooperative process group and cleans HOME", async () => {
    const child = await spawnSupervisedProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          'process.on("SIGINT", () => {});',
          'process.stdout.write(JSON.stringify({ home: process.env.HOME, explicit: process.env.MOB_EXPLICIT, leaked: process.env.npm_execpath }) + "\\n");',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      cwd: process.cwd(),
      env: { MOB_EXPLICIT: "yes" },
      killGraceMs: 40,
    });
    const home = child.homeDirectory;

    try {
      const [chunk] = (await once(child.child.stdout, "data")) as [Buffer];
      const observed = JSON.parse(chunk.toString("utf8")) as {
        home: string;
        explicit: string;
        leaked?: string;
      };
      expect(observed.home).toBe(home);
      expect(observed.explicit).toBe("yes");
      expect(observed.leaked).toBeUndefined();

      await child.cancel({ signal: "SIGINT", graceMs: 40 });
      const exit = await child.exit;
      if (process.platform !== "win32") expect(exit.signal).toBe("SIGKILL");
    } finally {
      if (!child.hasExited) await child.forceKill();
      await child.cleanup();
    }

    await expect(access(home)).rejects.toThrow();
  });

  it("copies a read-only provider profile into disposable writable CLI state", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mob-profile-seed-"));
    const source = join(fixture, "source");
    await mkdir(source);
    await writeFile(join(source, "models.json"), '{"provider":"mob-ai"}\n', { mode: 0o444 });

    let child: Awaited<ReturnType<typeof spawnSupervisedProcess>> | undefined;
    try {
      child = await spawnSupervisedProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const profile = process.env.PI_CODING_AGENT_DIR;',
            'fs.mkdirSync(path.join(profile, "auth.json.lock"));',
            'fs.writeFileSync(path.join(profile, "models.json"), "mutated\\n");',
            'process.stdout.write(JSON.stringify({ profile, home: process.env.HOME }));',
          ].join(""),
        ],
        cwd: fixture,
        env: { PI_CODING_AGENT_DIR: source },
        profileSeed: {
          sourceDirectory: source,
          files: ["models.json"],
          environmentVariables: ["PI_CODING_AGENT_DIR"],
        },
      });
      const [chunk] = (await once(child.child.stdout, "data")) as [Buffer];
      const observed = JSON.parse(chunk.toString("utf8")) as { profile: string; home: string };
      expect(observed.profile).toBe(join(observed.home, "agent"));
      expect(observed.profile).not.toBe(source);
      await child.exit;
      expect(await readFile(join(source, "models.json"), "utf8")).toBe('{"provider":"mob-ai"}\n');
    } finally {
      if (child) await child.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link provider profile and removes the partial HOME", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mob-profile-link-"));
    const real = join(fixture, "real");
    const linked = join(fixture, "linked");
    await mkdir(real);
    await writeFile(join(real, "models.json"), "{}\n");
    await symlink(real, linked);
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("mob-agent-")));
    try {
      await expect(spawnSupervisedProcess({
        command: process.execPath,
        cwd: fixture,
        profileSeed: {
          sourceDirectory: linked,
          files: ["models.json"],
          environmentVariables: ["PI_CODING_AGENT_DIR"],
        },
      })).rejects.toThrow("real directory");
      const after = (await readdir(tmpdir())).filter((name) => name.startsWith("mob-agent-"));
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link provider file", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mob-profile-file-link-"));
    const source = join(fixture, "source");
    const outside = join(fixture, "outside.json");
    await mkdir(source);
    await writeFile(outside, "{}\n");
    await symlink(outside, join(source, "models.json"));
    try {
      await expect(spawnSupervisedProcess({
        command: process.execPath,
        cwd: fixture,
        profileSeed: {
          sourceDirectory: source,
          files: ["models.json"],
          environmentVariables: ["PI_CODING_AGENT_DIR"],
        },
      })).rejects.toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
