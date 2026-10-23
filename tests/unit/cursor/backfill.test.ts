import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CursorUsageEvent } from "../../../src/cursor/types.js";
import type { OTLPLogsPayload } from "../../../src/_core/types/index.js";
import { createUsageEvent, createCursorConfig } from "../../helpers/fixtures.js";

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(true),
  loadConfig: vi.fn(),
  getConfigPath: () => "/tmp/revenium-cursor-absent/revenium.env",
  getFishConfigPath: () => "/tmp/revenium-cursor-absent/revenium.fish",
}));

vi.mock("../../../src/cursor/core/cursor-client.js", () => ({
  fetchEvents: vi.fn(),
  getCursorMinRequestIntervalMs: vi.fn().mockReturnValue(0),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendLogsWithResult: vi.fn(),
}));

vi.mock("ora", () => ({
  default: () => {
    const spinner = {
      text: "",
      start: () => spinner,
      succeed: () => spinner,
      fail: () => spinner,
      warn: () => spinner,
      stop: () => spinner,
    };
    return spinner;
  },
}));

import { backfillCommand } from "../../../src/cursor/commands/backfill.js";
import { loadConfig } from "../../../src/cursor/config/loader.js";
import { fetchEvents } from "../../../src/cursor/core/cursor-client.js";
import { sendLogsWithResult } from "../../../src/_core/api/otlp-client.js";

describe("cursor backfill summary cost", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue(createCursorConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function totalCostLine(events: CursorUsageEvent[]) {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield events;
    });
    await backfillCommand({ dryRun: true });
    return logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("Total cost:"));
  }

  it("excludes plan-included events from the reported spend", async () => {
    const line = await totalCostLine([
      createUsageEvent({ kind: "Included in Business", timestamp: 1700000000000 }),
      createUsageEvent({ kind: "Included in Pro", timestamp: 1700000001000 }),
    ]);

    expect(line).toContain("$0.00");
  });

  it("still reports the cost of usage-based events", async () => {
    const line = await totalCostLine([
      createUsageEvent({ kind: "Usage-based", timestamp: 1700000002000 }),
      createUsageEvent({ kind: "Included in Business", timestamp: 1700000003000 }),
    ]);

    expect(line).toContain("$0.05");
  });
});

describe("cursor backfill window end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue(createCursorConfig());
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield [];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fetchedWindowEnd(to: string): Promise<number> {
    await backfillCommand({ since: "2026-09-01", to, dryRun: true });
    return vi.mocked(fetchEvents).mock.calls[0][2] as number;
  }

  it("fetches through the last millisecond of a date-only --to", async () => {
    expect(await fetchedWindowEnd("2026-09-30")).toBe(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
  });

  it("fetches up to the exact instant of a --to carrying a time", async () => {
    expect(await fetchedWindowEnd("2026-09-30T12:00:00Z")).toBe(Date.parse("2026-09-30T12:00:00Z"));
  });

  it("announces the inclusive end of a date-only window", async () => {
    await backfillCommand({ since: "2026-09-01", to: "2026-09-30", dryRun: true });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("Fetching records until: 2026-09-30T23:59:59.999Z");
  });

  it("refuses a window whose end precedes its start instead of importing nothing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      backfillCommand({ since: "2026-09-30", to: "2026-09-01", dryRun: true }),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("leaves no gap and no overlap between consecutive month windows", async () => {
    async function requestedWindow(since: string, to: string): Promise<[number, number]> {
      vi.mocked(fetchEvents).mockClear();
      await backfillCommand({ since, to, dryRun: true });
      const [, fromMs, toMs] = vi.mocked(fetchEvents).mock.calls[0];
      return [fromMs as number, toMs as number];
    }

    const september = await requestedWindow("2026-09-01", "2026-09-30");
    const october = await requestedWindow("2026-10-01", "2026-10-31");

    expect(october[0] - september[1]).toBe(1);
  });

  it("accepts a relative --to, as the help text promises", async () => {
    await backfillCommand({ since: "1m", to: "7d", dryRun: true });

    expect(fetchEvents).toHaveBeenCalled();
  });
});

describe("cursor backfill exit status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REVENIUM_STARTUP_STAGGER_MS = "0";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue(createCursorConfig());
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield [createUsageEvent({ kind: "Usage-based", timestamp: 1700000000000 })];
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    delete process.env.REVENIUM_STARTUP_STAGGER_MS;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function output(): string {
    return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
  }

  function sentRecordCounts(): number[] {
    return vi
      .mocked(sendLogsWithResult)
      .mock.calls.map(
        ([, , payload]) =>
          (payload as OTLPLogsPayload).resourceLogs[0].scopeLogs[0].logRecords.length,
      );
  }

  it("fails the run and tells the operator to re-run when a batch is lost", async () => {
    vi.mocked(sendLogsWithResult).mockResolvedValue({
      success: false,
      error: "fetch failed (ECONNRESET)",
    });

    await backfillCommand({});

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Backfill incomplete");
    expect(output()).not.toContain("Backfill complete!");
  });

  it("sends fetched pages before a later page fails", async () => {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      for (let page = 0; page < 3; page++) {
        yield Array.from({ length: 100 }, (_, index) =>
          createUsageEvent({
            kind: "Usage-based",
            timestamp: 1700000000000 + page * 100000 + index,
          }),
        );
      }
      throw new Error("fetch failed");
    });
    vi.mocked(sendLogsWithResult).mockResolvedValue({ success: true });

    await backfillCommand({ batchSize: 100 });

    expect(sentRecordCounts().reduce((sum, count) => sum + count, 0)).toBe(300);
    expect(process.exitCode).toBe(1);
    expect(output()).not.toContain("Backfill complete!");
    expect(output()).toContain("Re-run the same window to finish the import");
  });

  it("fails a dry run that stopped fetching midway", async () => {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield [createUsageEvent({ kind: "Usage-based", timestamp: 1700000000000 })];
      throw new Error("fetch failed");
    });

    await backfillCommand({ dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
    expect(output()).toContain("Dry run incomplete");
    expect(output()).not.toContain("Dry run complete");
  });

  it("advises re-running the window instead of resuming from a sent timestamp", async () => {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield [
        createUsageEvent({ kind: "Usage-based", timestamp: Date.parse("2024-06-20T10:00:00Z") }),
        createUsageEvent({ kind: "Usage-based", timestamp: Date.parse("2024-06-10T10:00:00Z") }),
      ];
      throw new Error("fetch failed");
    });
    vi.mocked(sendLogsWithResult).mockResolvedValue({ success: true });

    await backfillCommand({ batchSize: 2 });

    expect(output()).not.toContain("Resume from:");
    expect(output()).toContain("Re-run the same window to finish the import");
  });

  it("records a batch whose send threw as a failed batch", async () => {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield [createUsageEvent({ kind: "Usage-based", timestamp: 1700000000000 })];
    });
    vi.mocked(sendLogsWithResult).mockRejectedValue(new Error("socket hang up"));

    await backfillCommand({ batchSize: 1 });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Failed Batches:");
    expect(output()).toContain("socket hang up");
  });

  it("never exceeds the batch size", async () => {
    vi.mocked(fetchEvents).mockImplementation(async function* () {
      yield Array.from({ length: 100 }, (_, index) =>
        createUsageEvent({ kind: "Usage-based", timestamp: 1700000000000 + index }),
      );
    });
    vi.mocked(sendLogsWithResult).mockResolvedValue({ success: true });

    await backfillCommand({ batchSize: 10 });

    const counts = sentRecordCounts();
    expect(counts).toHaveLength(10);
    expect(Math.max(...counts)).toBeLessThanOrEqual(10);
  });
});
