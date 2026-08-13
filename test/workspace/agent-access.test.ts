import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredAgentIdentity,
  revokeAgentWorkspace,
} from "../../src/workspace/agent-access.js";

describe("Agent OS identity", () => {
  it("is optional for local development", () => {
    expect(configuredAgentIdentity({})).toBeUndefined();
  });

  it("requires a complete positive uid/gid pair", () => {
    expect(configuredAgentIdentity({ MOB_AGENT_UID: "10001", MOB_AGENT_GID: "10001" }))
      .toEqual({ uid: 10001, gid: 10001 });
    expect(() => configuredAgentIdentity({ MOB_AGENT_UID: "10001" })).toThrow(
      "positive integers",
    );
    expect(() => configuredAgentIdentity({ MOB_AGENT_UID: "0", MOB_AGENT_GID: "10001" }))
      .toThrow("positive integers");
  });

  it("freezes group/other-writable descendants without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-agent-freeze-"));
    const checkout = join(root, "checkout");
    const outside = join(root, "outside.txt");
    try {
      await mkdir(join(checkout, "nested"), { recursive: true });
      await writeFile(join(checkout, "nested", "work.txt"), "work\n");
      await writeFile(outside, "outside\n");
      await chmod(join(checkout, "nested"), 0o777);
      await chmod(join(checkout, "nested", "work.txt"), 0o666);
      await chmod(outside, 0o666);
      await symlink(outside, join(checkout, "nested", "escape"));

      await revokeAgentWorkspace(checkout);

      expect((await stat(join(checkout, "nested"))).mode & 0o022).toBe(0);
      expect((await stat(join(checkout, "nested", "work.txt"))).mode & 0o022).toBe(0);
      expect((await stat(outside)).mode & 0o777).toBe(0o666);
      expect((await lstat(join(checkout, "nested", "escape"))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link task root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mob-agent-root-link-"));
    try {
      const target = join(root, "target");
      const linked = join(root, "linked");
      await mkdir(target);
      await symlink(target, linked);
      await expect(revokeAgentWorkspace(linked)).rejects.toThrow("symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
