import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const testDir = join(tmpdir(), `revenium-copilot-test-${randomBytes(4).toString("hex")}`);

vi.mock("../../../src/copilot/config/loader.js", () => ({
  getConfigDir: () => testDir,
  getConfigPath: () => join(testDir, "revenium.env"),
  configExists: () => false,
  loadConfig: () => Promise.resolve(null),
}));

import { loadState, saveState, resetState } from "../../../src/copilot/core/sync/state-manager.js";

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
    expect(state.sentRecords).toEqual({});
  });

  it("loads state from existing file", async () => {
    const data = {
      lastSyncTimestamp: 12345,
      lastSyncEventCount: 10,
      totalEventsSynced: 100,
      sentRecords: { "2024-06-15": ["abc"] },
    };
    writeFileSync(join(testDir, "state.json"), JSON.stringify(data));
    const state = await loadState();
    expect(state.lastSyncTimestamp).toBe(12345);
    expect(state.sentRecords).toEqual({ "2024-06-15": ["abc"] });
  });

  it("drops a legacy recentHashes file without losing the watermark", async () => {
    const data = {
      lastSyncTimestamp: 12345,
      lastSyncEventCount: 10,
      totalEventsSynced: 100,
      recentHashes: ["abc"],
    };
    writeFileSync(join(testDir, "state.json"), JSON.stringify(data));
    const state = await loadState();
    expect(state.lastSyncTimestamp).toBe(12345);
    expect(state.sentRecords).toEqual({});
  });

  it("degrades a corrupt sentRecords value to an empty log", async () => {
    for (const sentRecords of [["abc"], "abc", { "2024-06-15": [1, 2] }]) {
      writeFileSync(
        join(testDir, "state.json"),
        JSON.stringify({ lastSyncTimestamp: 12345, sentRecords }),
      );
      const state = await loadState();
      expect(state.lastSyncTimestamp).toBe(12345);
      expect(state.sentRecords).toEqual({});
    }
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
      sentRecords: { "2024-06-15": ["h1", "h2"] },
    });
    const content = readFileSync(join(testDir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.lastSyncTimestamp).toBe(999);
    expect(parsed.sentRecords).toEqual({ "2024-06-15": ["h1", "h2"] });
  });

  it("round-trips a log far larger than the former hash cap", async () => {
    const fingerprints = Array.from({ length: 25_000 }, (_, i) => `h${i}`);
    await saveState({
      lastSyncTimestamp: 1,
      lastSyncEventCount: 0,
      totalEventsSynced: 0,
      sentRecords: { "2024-06-15": fingerprints },
    });
    const state = await loadState();
    expect(state.sentRecords["2024-06-15"]).toHaveLength(25_000);
  });
});

describe("resetState", () => {
  it("creates default state file", async () => {
    await resetState();
    const content = readFileSync(join(testDir, "state.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.lastSyncTimestamp).toBe(0);
    expect(parsed.sentRecords).toEqual({});
  });
});
