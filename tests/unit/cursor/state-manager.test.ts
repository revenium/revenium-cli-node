import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const testDir = join(tmpdir(), `revenium-test-${randomBytes(4).toString("hex")}`);

vi.mock("../../../src/cursor/config/loader.js", () => ({
  getConfigDir: () => testDir,
  getConfigPath: () => join(testDir, "revenium.env"),
  configExists: () => false,
  loadConfig: () => Promise.resolve(null),
}));

import { loadState, saveState, resetState } from "../../../src/cursor/core/sync/state-manager.js";

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("loadState", () => {
  it("returns default state when file missing", async () => {
    const state = await loadState();
    expect(state.lastSyncTimestamp).toBe(0);
    expect(state.lastSyncEventCount).toBe(0);
    expect(state.totalEventsSynced).toBe(0);
    expect(state.recentHashes).toEqual([]);
  });

  it("loads state from existing file", async () => {
    const data = {
      lastSyncTimestamp: 12345,
      lastSyncEventCount: 10,
      totalEventsSynced: 100,
      recentHashes: ["abc"],
    };
    writeFileSync(join(testDir, "state.json"), JSON.stringify(data));
    const state = await loadState();
    expect(state.lastSyncTimestamp).toBe(12345);
    expect(state.recentHashes).toEqual(["abc"]);
  });

  it("returns default on corrupt JSON", async () => {
    writeFileSync(join(testDir, "state.json"), "not json");
    const state = await loadState();
    expect(state.lastSyncTimestamp).toBe(0);
  });
});

describe("saveState", () => {
  it("writes state atomically", async () => {
    await saveState({
      lastSyncTimestamp: 999,
      lastSyncEventCount: 5,
      totalEventsSynced: 50,
      recentHashes: ["h1", "h2"],
    });
    const content = readFileSync(join(testDir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.lastSyncTimestamp).toBe(999);
    expect(parsed.recentHashes).toEqual(["h1", "h2"]);
  });

  it("trims hashes to MAX_RECENT_HASHES", async () => {
    const hashes = Array.from({ length: 15000 }, (_, i) => `h${i}`);
    await saveState({
      lastSyncTimestamp: 1,
      lastSyncEventCount: 0,
      totalEventsSynced: 0,
      recentHashes: hashes,
    });
    const content = readFileSync(join(testDir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.recentHashes.length).toBeLessThanOrEqual(10000);
  });
});

describe("resetState", () => {
  it("creates default state file", async () => {
    await resetState();
    const content = readFileSync(join(testDir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.lastSyncTimestamp).toBe(0);
    expect(parsed.recentHashes).toEqual([]);
  });
});
