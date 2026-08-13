import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  contents: new Map<string, string>(),
  existsSync: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  chmod: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => "/home/testuser",
    platform: () => "darwin" as NodeJS.Platform,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    mkdir: mocks.mkdir,
    copyFile: mocks.copyFile,
    chmod: mocks.chmod,
    readdir: mocks.readdir,
    unlink: mocks.unlink,
  };
});

import {
  emitManagedSettingsTemplate,
  installTicketGateHook,
  uninstallTicketGateHook,
} from "../../../src/claude-code/ticket/hook-installer.js";

const USER_SETTINGS = "/home/testuser/.claude/settings.json";
const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";
const HOOK = "/home/testuser/.revenium/hooks/ticket-gate.sh";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existingPaths.clear();
  mocks.contents.clear();

  mocks.existsSync.mockImplementation((path) => {
    const value = String(path);
    return value.endsWith("ticket-gate.sh") || mocks.existingPaths.has(value);
  });
  mocks.readFile.mockImplementation(async (path) => {
    const value = String(path);
    const contents = mocks.contents.get(value);
    if (contents !== undefined) return contents;

    const error = new Error(
      `ENOENT: no such file or directory, open '${value}'`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
  mocks.readdir.mockResolvedValue([]);
});

describe("user settings safety", () => {
  it.each([
    ["install", installTicketGateHook],
    ["uninstall", uninstallTicketGateHook],
  ])("aborts %s without overwriting malformed settings", async (_name, operation) => {
    mocks.existingPaths.add(USER_SETTINGS);
    mocks.contents.set(USER_SETTINGS, "{ not valid JSON");

    await expect(operation()).rejects.toThrow(
      `Invalid JSON in existing settings at ${USER_SETTINGS}`,
    );
    expect(mocks.writeFile).not.toHaveBeenCalledWith(
      USER_SETTINGS,
      expect.anything(),
      expect.anything(),
    );
  });

  it("surfaces non-missing read errors without overwriting settings", async () => {
    const error = new Error(
      `EACCES: permission denied, open '${USER_SETTINGS}'`,
    ) as NodeJS.ErrnoException;
    error.code = "EACCES";
    mocks.readFile.mockRejectedValueOnce(error);

    await expect(installTicketGateHook()).rejects.toThrow(
      `Unable to read existing settings at ${USER_SETTINGS}`,
    );
    expect(mocks.writeFile).not.toHaveBeenCalledWith(
      USER_SETTINGS,
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });
});

describe("managed settings writes", () => {
  it("merges gate hooks, preserves existing settings, and backs up before writing", async () => {
    mocks.existingPaths.add(MANAGED_SETTINGS);
    mocks.contents.set(
      MANAGED_SETTINGS,
      JSON.stringify({
        allowManagedHooksOnly: false,
        permissions: { deny: ["Bash(rm:*)"] },
        customPolicy: "preserve-me",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "/other/pre-tool.sh" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "/other/prompt-hook.sh" }] }],
        },
      }),
    );

    const result = await emitManagedSettingsTemplate({ write: true, outputDir: "/output" });

    expect(result.written).toBe(true);
    const managedWrite = mocks.writeFile.mock.calls.find(([path]) => path === MANAGED_SETTINGS);
    expect(managedWrite).toBeDefined();
    const written = JSON.parse(managedWrite?.[1] as string) as Record<string, any>;
    expect(written.permissions).toEqual({ deny: ["Bash(rm:*)"] });
    expect(written.customPolicy).toBe("preserve-me");
    expect(written.allowManagedHooksOnly).toBe(true);
    expect(written.hooks.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "/other/pre-tool.sh" }] },
    ]);
    expect(written.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "/other/prompt-hook.sh" }] },
      { hooks: [{ type: "command", command: HOOK }] },
    ]);
    expect(written.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: HOOK }] }]);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      MANAGED_SETTINGS,
      expect.stringMatching(
        /^\/Library\/Application Support\/ClaudeCode\/managed-settings\.json\.revenium-backup-/,
      ),
    );
  });

  it("aborts without overwriting or backing up malformed managed settings", async () => {
    mocks.existingPaths.add(MANAGED_SETTINGS);
    mocks.contents.set(MANAGED_SETTINGS, "{ malformed");

    await expect(
      emitManagedSettingsTemplate({ write: true, outputDir: "/output" }),
    ).rejects.toThrow(`Invalid JSON in existing settings at ${MANAGED_SETTINGS}`);
    expect(mocks.writeFile).not.toHaveBeenCalledWith(
      MANAGED_SETTINGS,
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.copyFile).not.toHaveBeenCalledWith(MANAGED_SETTINGS, expect.anything());
  });
});

describe("settings backup retention", () => {
  const currentTimestamp = "2026-07-22T12-34-56-789Z";
  const backup = (timestamp: string) => `settings.json.revenium-backup-${timestamp}`;

  async function installOverExistingSettings(directoryEntries: string[]) {
    mocks.existingPaths.add(USER_SETTINGS);
    mocks.contents.set(USER_SETTINGS, "{}");
    mocks.readdir.mockResolvedValue(directoryEntries);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:34:56.789Z"));
    try {
      return await installTicketGateHook();
    } finally {
      vi.useRealTimers();
    }
  }

  it("keeps the five newest backups and prunes older backups after writing", async () => {
    const backups = [
      backup("2026-07-17T12-00-00-000Z"),
      backup("2026-07-18T12-00-00-000Z"),
      backup("2026-07-19T12-00-00-000Z"),
      backup("2026-07-20T12-00-00-000Z"),
      backup("2026-07-21T12-00-00-000Z"),
      backup(currentTimestamp),
    ];

    await installOverExistingSettings(backups.reverse());

    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json.revenium-backup-2026-07-17T12-00-00-000Z",
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(USER_SETTINGS, expect.any(String), "utf-8");
  });

  it("retains the backup just created even if the system clock moved backward", async () => {
    const backups = [
      backup(currentTimestamp),
      backup("2026-07-23T12-00-00-000Z"),
      backup("2026-07-24T12-00-00-000Z"),
      backup("2026-07-25T12-00-00-000Z"),
      backup("2026-07-26T12-00-00-000Z"),
      backup("2026-07-27T12-00-00-000Z"),
    ];

    await installOverExistingSettings(backups);

    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledWith(
      "/home/testuser/.claude/settings.json.revenium-backup-2026-07-23T12-00-00-000Z",
    );
    expect(mocks.unlink).not.toHaveBeenCalledWith(
      `/home/testuser/.claude/${backup(currentTimestamp)}`,
    );
  });

  it("does not prune backups or similarly named files for other settings targets", async () => {
    const unrelated = [
      "other-settings.json.revenium-backup-2020-01-01T00-00-00-000Z",
      "settings.json.revenium-backup-not-a-timestamp",
      "settings.json.revenium-backup-2020-01-01T00-00-00-000Z.tmp",
    ];
    const backups = [
      backup("2026-07-17T12-00-00-000Z"),
      backup("2026-07-18T12-00-00-000Z"),
      backup("2026-07-19T12-00-00-000Z"),
      backup("2026-07-20T12-00-00-000Z"),
      backup("2026-07-21T12-00-00-000Z"),
      backup(currentTimestamp),
      ...unrelated,
    ];

    await installOverExistingSettings(backups);

    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    for (const name of unrelated) {
      expect(mocks.unlink).not.toHaveBeenCalledWith(`/home/testuser/.claude/${name}`);
    }
  });

  it("keeps a successful settings write successful when backup pruning fails", async () => {
    mocks.existingPaths.add(USER_SETTINGS);
    mocks.contents.set(USER_SETTINGS, "{}");
    mocks.readdir.mockRejectedValueOnce(new Error("simulated cleanup failure"));

    await expect(installTicketGateHook()).resolves.toMatchObject({ installed: true });
    expect(mocks.writeFile).toHaveBeenCalledWith(USER_SETTINGS, expect.any(String), "utf-8");
  });

  it("does not prune backups when the settings write fails", async () => {
    mocks.existingPaths.add(USER_SETTINGS);
    mocks.contents.set(USER_SETTINGS, "{}");
    mocks.writeFile.mockRejectedValueOnce(new Error("simulated write failure"));

    await expect(installTicketGateHook()).rejects.toThrow("simulated write failure");
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
