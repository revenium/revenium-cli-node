import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Ora } from "ora";
import { FailedBatchLog, reportBackfillOutcome } from "../../../src/_core/ui/backfill-outcome.js";

function createSpinner(): Ora {
  return { succeed: vi.fn(), warn: vi.fn() } as unknown as Ora;
}

describe("reportBackfillOutcome", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("reports the run as complete when every batch landed", () => {
    const spinner = createSpinner();

    const complete = reportBackfillOutcome(spinner, {
      sentRecords: 1200,
      sentBatches: 3,
      failedBatches: [],
    });

    expect(complete).toBe(true);
    expect(spinner.succeed).toHaveBeenCalledWith("Sent 1,200 records in 3 batches");
    expect(logged.join("\n")).toContain("Backfill complete!");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports the run as incomplete so the caller can fail it when a batch is lost", () => {
    const spinner = createSpinner();

    const complete = reportBackfillOutcome(spinner, {
      sentRecords: 400,
      sentBatches: 1,
      failedBatches: [{ batchNumber: 2, error: "ECONNRESET" }],
    });

    const output = logged.join("\n");
    expect(complete).toBe(false);
    expect(spinner.warn).toHaveBeenCalledWith("Sent 400 records in 1 batches (1 failed)");
    expect(output).toContain("Batch 2: ECONNRESET");
    expect(output).toContain("Backfill incomplete");
    expect(output).not.toContain("Backfill complete!");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports the run as incomplete when fetching stopped even though every batch landed", () => {
    const spinner = createSpinner();

    const complete = reportBackfillOutcome(spinner, {
      sentRecords: 300,
      sentBatches: 3,
      failedBatches: [],
      fetchError: "socket hang up",
    });

    expect(complete).toBe(false);
    expect(spinner.warn).toHaveBeenCalledWith("Sent 300 records in 3 batches");
    expect(logged.join("\n")).not.toContain("Backfill complete!");
  });

  it("names where to resume on the failure path", () => {
    reportBackfillOutcome(createSpinner(), {
      sentRecords: 300,
      sentBatches: 3,
      failedBatches: [],
      fetchError: "socket hang up",
      lastSentMarker: "2024-06-15",
    });

    expect(logged.join("\n")).toContain("Resume from: 2024-06-15");
  });

  it("omits the resume marker when batches were lost, since it would skip them", () => {
    reportBackfillOutcome(createSpinner(), {
      sentRecords: 300,
      sentBatches: 3,
      failedBatches: [{ batchNumber: 2, error: "ECONNRESET" }],
      lastSentMarker: "2024-06-15",
    });

    expect(logged.join("\n")).not.toContain("Resume from:");
  });

  it("counts the failures it did not list", () => {
    const spinner = createSpinner();

    reportBackfillOutcome(spinner, {
      sentRecords: 300,
      sentBatches: 3,
      failedBatches: [{ batchNumber: 2, error: "ECONNRESET" }],
      omittedFailures: 9,
    });

    expect(spinner.warn).toHaveBeenCalledWith("Sent 300 records in 3 batches (10 failed)");
    expect(logged.join("\n")).toContain("...and 9 more failed batch(es)");
    expect(logged.join("\n")).toContain("Backfill incomplete: 10 batch(es) were not sent.");
  });

  it("leaves the output of a run without the new fields untouched", () => {
    reportBackfillOutcome(createSpinner(), {
      sentRecords: 400,
      sentBatches: 1,
      failedBatches: [{ batchNumber: 2, error: "ECONNRESET" }],
    });

    expect(logged.join("\n")).not.toContain("Resume from:");
  });
});

describe("FailedBatchLog", () => {
  it("retains failures up to its capacity and counts the rest", () => {
    const log = new FailedBatchLog(2);

    log.record(1, "ECONNRESET");
    log.record(2, "ECONNRESET");
    log.record(3, "ECONNRESET");
    log.record(4, "ECONNRESET");

    expect(log.entries).toEqual([
      { batchNumber: 1, error: "ECONNRESET" },
      { batchNumber: 2, error: "ECONNRESET" },
    ]);
    expect(log.omitted).toBe(2);
  });
});
