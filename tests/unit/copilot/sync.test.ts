import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/copilot/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(false),
  loadConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/copilot/core/sync/scheduler.js", () => ({
  runSyncCycle: vi.fn(),
  SyncWatcher: vi.fn(),
}));

import { syncCommand } from "../../../src/copilot/commands/sync.js";

describe("copilot syncCommand deprecation notice", () => {
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
      .filter((line) => line.includes("is deprecated and will be removed in 2.0.0"));
  }

  it("prints the notice once, before the missing-configuration guard", async () => {
    await expect(syncCommand()).rejects.toThrow("process.exit");

    const lines = noticeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("revenium-copilot sync");
  });

  it("prints the notice once in watch mode", async () => {
    await expect(syncCommand({ watch: true })).rejects.toThrow("process.exit");

    expect(noticeLines()).toHaveLength(1);
  });
});
