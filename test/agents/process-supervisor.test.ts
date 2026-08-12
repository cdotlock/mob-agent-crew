import { access } from "node:fs/promises";
import { once } from "node:events";
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
});
