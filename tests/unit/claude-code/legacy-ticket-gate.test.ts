import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacyTicketGate } from "../../../src/claude-code/config/legacy-ticket-gate.js";

let workDir: string;
let settingsPath: string;
let hookPath: string;

const gateEntry = (command: string) => [{ hooks: [{ type: "command", command }] }];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "legacy-ticket-gate-"));
  settingsPath = join(workDir, "settings.json");
  hookPath = join(workDir, "hooks", "ticket-gate.sh");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("removeLegacyTicketGate", () => {
  it("removes gate hooks from settings, backs up, and deletes the script", async () => {
    const settings = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [
          ...gateEntry(hookPath),
          { hooks: [{ type: "command", command: "/other/hook.sh" }] },
        ],
        SessionStart: gateEntry(hookPath),
        PostToolUse: gateEntry("/unrelated/hook.sh"),
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");
    await mkdir(join(workDir, "hooks"), { recursive: true });
    await writeFile(hookPath, "#!/bin/bash\n", "utf-8");

    const result = await removeLegacyTicketGate({ settingsPath, hookPath });

    expect(result.hookRemovedFromSettings).toBe(true);
    expect(result.scriptDeleted).toBe(true);
    expect(existsSync(hookPath)).toBe(false);

    const updated = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(updated.model).toBe("opus");
    expect(updated.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "/other/hook.sh" }] },
    ]);
    expect(updated.hooks.SessionStart).toEqual([]);
    expect(updated.hooks.PostToolUse).toEqual(gateEntry("/unrelated/hook.sh"));

    const backups = (await readdir(workDir)).filter((name) =>
      name.startsWith("settings.json.revenium-backup-"),
    );
    expect(backups).toHaveLength(1);
  });

  it("is a no-op when no gate hook is installed", async () => {
    const settings = { hooks: { PostToolUse: gateEntry("/unrelated/hook.sh") } };
    await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

    const result = await removeLegacyTicketGate({ settingsPath, hookPath });

    expect(result.hookRemovedFromSettings).toBe(false);
    expect(result.scriptDeleted).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual(settings);
    expect((await readdir(workDir)).some((name) => name.includes("backup"))).toBe(false);
  });

  it("does not touch settings it cannot parse but still deletes the script", async () => {
    await writeFile(settingsPath, "{ invalid json", "utf-8");
    await mkdir(join(workDir, "hooks"), { recursive: true });
    await writeFile(hookPath, "#!/bin/bash\n", "utf-8");

    const result = await removeLegacyTicketGate({ settingsPath, hookPath });

    expect(result.hookRemovedFromSettings).toBe(false);
    expect(result.scriptDeleted).toBe(true);
    expect(await readFile(settingsPath, "utf-8")).toBe("{ invalid json");
  });

  it("handles a missing settings file", async () => {
    const result = await removeLegacyTicketGate({ settingsPath, hookPath });

    expect(result.hookRemovedFromSettings).toBe(false);
    expect(result.scriptDeleted).toBe(false);
  });
});
