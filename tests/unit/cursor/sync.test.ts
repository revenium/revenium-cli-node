import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isolatedTmpDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  return { isolatedTmpDir: mkdtempSync(join(tmpdir(), "revenium-cursor-sync-")) };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => isolatedTmpDir,
}));

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(false),
  loadConfig: vi.fn().mockResolvedValue(null),
  getConfigPath: () => "/tmp/revenium-cursor-absent/revenium.env",
  getFishConfigPath: () => "/tmp/revenium-cursor-absent/revenium.fish",
}));

vi.mock("../../../src/cursor/core/sync/scheduler.js", () => ({
  runSyncCycle: vi.fn(),
  SyncWatcher: vi.fn(),
}));

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCommand } from "../../../src/cursor/commands/sync.js";
import { configExists, loadConfig } from "../../../src/cursor/config/loader.js";
import { runSyncCycle } from "../../../src/cursor/core/sync/scheduler.js";
import { LOCK_FILE } from "../../../src/cursor/constants.js";
import type { CursorConfig, SyncResult } from "../../../src/cursor/types.js";

describe("cursor syncCommand deprecation notice", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function noticeLines() {
    return logSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("is deprecated and will be removed in 3.0.0"));
  }

  it("prints the notice once, before the missing-configuration guard", async () => {
    await expect(syncCommand()).rejects.toThrow("process.exit");

    const lines = noticeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("revenium-cursor sync");
  });

  it("prints the notice once in watch mode", async () => {
    await expect(syncCommand({ watch: true })).rejects.toThrow("process.exit");

    expect(noticeLines()).toHaveLength(1);
  });
});

describe("cursor syncCommand exit status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const CONFIG = {
    cursorApiKey: "cursor-key",
    reveniumApiKey: "revenium-key",
    reveniumEndpoint: "https://endpoint",
    syncIntervalMs: 60_000,
  } as CursorConfig;

  function syncResult(overrides: Partial<SyncResult>): SyncResult {
    return {
      fetched: 2,
      sent: 0,
      duplicatesSkipped: 0,
      invalidTimestampsSkipped: 0,
      errors: 0,
      ...overrides,
    };
  }

  function removeLock() {
    try {
      unlinkSync(join(tmpdir(), LOCK_FILE));
    } catch {
      // the lock is absent unless a previous cycle crashed
    }
  }

  beforeEach(() => {
    removeLock();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.mocked(configExists).mockReturnValue(true);
    vi.mocked(loadConfig).mockResolvedValue(CONFIG);
  });

  afterEach(() => {
    removeLock();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exits non-zero and announces the retry when Revenium refused events", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue(syncResult({ errors: 2 }));

    await expect(syncCommand()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Revenium did not accept 2 event(s)",
    );
  });

  it("exits zero when every event was accepted", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue(syncResult({ sent: 2 }));

    await expect(syncCommand()).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("syncs through the last millisecond of a date-only --to", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue(syncResult({ sent: 2 }));

    await syncCommand({ to: "2026-09-30" });

    expect(runSyncCycle).toHaveBeenCalledWith(
      CONFIG,
      undefined,
      Date.UTC(2026, 8, 30, 23, 59, 59, 999),
    );
  });

  it("syncs up to the exact instant of a --to carrying a time", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue(syncResult({ sent: 2 }));

    await syncCommand({ to: "2026-09-30T12:00:00Z" });

    expect(runSyncCycle).toHaveBeenCalledWith(
      CONFIG,
      undefined,
      Date.parse("2026-09-30T12:00:00Z"),
    );
  });

  it("rejects a relative --to instead of syncing an inverted window", async () => {
    await expect(syncCommand({ to: "7d" })).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runSyncCycle).not.toHaveBeenCalled();
  });

  it("accepts the epoch as --from", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue(syncResult({ sent: 2 }));

    await syncCommand({ from: "1970-01-01T00:00:00Z", to: "2026-09-30T12:00:00Z" });

    expect(runSyncCycle).toHaveBeenCalledWith(CONFIG, 0, Date.parse("2026-09-30T12:00:00Z"));
  });

  it("refuses a window whose end precedes its start", async () => {
    vi.mocked(runSyncCycle).mockRejectedValue(new Error("Invalid sync window"));

    await expect(syncCommand({ from: "2026-09-30T12:00:00Z", to: "2026-09-01" })).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
