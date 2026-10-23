import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CopilotUsageBreakdown, CopilotUsageDay } from "../../../src/copilot/types.js";
import { BILLING_PERMISSION_HINT } from "../../../src/copilot/constants.js";
import type { OTLPTracesPayload } from "../../../src/_core/types/index.js";
import {
  createCopilotBreakdown,
  createCopilotConfig,
  createCopilotUsageDay,
} from "../../helpers/fixtures.js";

vi.mock("../../../src/copilot/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(true),
  loadConfig: vi.fn(),
}));

vi.mock("../../../src/copilot/core/github-client.js", () => ({
  fetchUsageDays: vi.fn(),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendTracesWithResult: vi.fn(),
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

import { backfillCommand } from "../../../src/copilot/commands/backfill.js";
import { loadConfig } from "../../../src/copilot/config/loader.js";
import { fetchUsageDays } from "../../../src/copilot/core/github-client.js";
import { sendTracesWithResult } from "../../../src/_core/api/otlp-client.js";

const CREDENTIALS = { githubToken: "token", githubOrg: "acme" };

function usageFetch(days: CopilotUsageDay[]) {
  return { days, unmatchedBilling: [], billingUnavailable: [] };
}

function breakdowns(count: number, day: string): CopilotUsageBreakdown[] {
  return Array.from({ length: count }, (_, index) =>
    createCopilotBreakdown({ user_login: `${day}-dev-${index}` }),
  );
}

describe("copilot backfill streaming", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REVENIUM_STARTUP_STAGGER_MS = "0";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue(createCopilotConfig());
    vi.mocked(sendTracesWithResult).mockResolvedValue({ success: true });
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

  function sentSpanCounts(): number[] {
    return vi
      .mocked(sendTracesWithResult)
      .mock.calls.map(
        ([, , payload]) =>
          (payload as OTLPTracesPayload).resourceSpans[0].scopeSpans[0].spans.length,
      );
  }

  it("splits a single day that holds more records than the batch size", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(250, "a") }),
      ]);
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 100 });

    const counts = sentSpanCounts();
    expect(counts).toEqual([100, 100, 50]);
    expect(process.exitCode).toBeUndefined();
  });

  it("delivers the days fetched before a later day fails", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(100, "a") }),
      ]);
      throw new Error("github unavailable");
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 100 });

    expect(sentSpanCounts()).toEqual([100]);
    expect(process.exitCode).toBe(1);
    expect(output()).not.toContain("Backfill complete!");
    expect(output()).toContain("Resume from: 2024-06-15");
  });

  it("does not report an empty date range when the organization could not be reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      throw new Error(
        'GitHub organization "revenium-no-such-org" could not be reached with this token.',
      );
    });

    await backfillCommand({ ...CREDENTIALS, githubOrg: "revenium-no-such-org" });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "revenium-no-such-org",
    );
    expect(output()).not.toContain("No usage data found in the specified date range.");
  });

  it("fails a dry run that stopped fetching midway", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(10, "a") }),
      ]);
      throw new Error("github unavailable");
    });

    await backfillCommand({ ...CREDENTIALS, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(sendTracesWithResult).not.toHaveBeenCalled();
    expect(output()).toContain("Dry run incomplete");
    expect(output()).not.toContain("Dry run complete");
  });

  it("records a batch whose send threw as a failed batch", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(1, "a") }),
      ]);
    });
    vi.mocked(sendTracesWithResult).mockRejectedValue(new Error("socket hang up"));

    await backfillCommand({ ...CREDENTIALS, batchSize: 1 });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Failed Batches:");
    expect(output()).toContain("socket hang up");
  });

  it("omits the resume marker when batches were lost", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(1, "a") }),
        createCopilotUsageDay({ day: "2024-06-16", breakdown: breakdowns(1, "b") }),
      ]);
    });
    vi.mocked(sendTracesWithResult)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "ECONNRESET" });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1 });

    expect(output()).not.toContain("Resume from:");
  });

  it("fails the run and withholds the success line when a batch is lost", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(2, "a") }),
      ]);
    });
    vi.mocked(sendTracesWithResult).mockResolvedValue({ success: false, error: "ECONNRESET" });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1 });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Backfill incomplete");
    expect(output()).not.toContain("Backfill complete!");
  });

  it("fails the run and names the day whose billing could not be read", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(1, "a") })],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: `GitHub API 403 Forbidden - denied ${BILLING_PERMISSION_HINT}`,
            withheldRecords: 4,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1 });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Billing data unavailable");
    expect(output()).toContain("2024-06-15");
    expect(output()).toContain("403 Forbidden");
    expect(output()).toContain("4 record(s) withheld");
    expect(output()).toContain("Records withheld: 4");
    expect(output()).not.toContain("Backfill complete!");
  });

  it("does not claim there is no usage data when every record of the day was withheld", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 4,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, since: "7d", batchSize: 1 });

    expect(process.exitCode).toBe(1);
    expect(output()).not.toContain("No usage data found");
    expect(output()).not.toContain("Try a broader date range");
    expect(output()).toContain("their billing data could not be read");
  });

  it("imports the usage of a day without billing when the caller allows it", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(1, "a") })],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 1,
            unresolved: false,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1, allowMissingBilling: true });

    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain("Backfill complete!");
    expect(output()).toContain("1 record(s) allowed through without billing data");
    expect(output()).toContain("--allow-missing-billing");
    expect(output()).not.toContain("No cost-bearing record was affected");
  });

  it("keeps a dry run successful when billing could not be read", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [createCopilotUsageDay({ day: "2024-06-15", breakdown: breakdowns(1, "a") })],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 4,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1, dryRun: true });

    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain("Dry run complete");
  });

  it("keeps a dry run successful when every record of the window was withheld", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 4,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1, dryRun: true });

    expect(process.exitCode).toBeUndefined();
  });

  it("reports no usage when the only days fetched were empty days without billing", async () => {
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2024-06-15",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await backfillCommand({ ...CREDENTIALS, batchSize: 1 });

    expect(output()).toContain("No usage data found in the specified date range.");
    expect(output()).toContain("Copilot usage metrics policy is enabled");
    expect(output()).not.toContain("All fetched records were duplicates");
  });

  it("delivers every record of a large organization at the default batch size", async () => {
    const developerCount = 15000;
    vi.mocked(fetchUsageDays).mockImplementation(async function* () {
      yield usageFetch([
        createCopilotUsageDay({
          day: "2024-06-15",
          breakdown: breakdowns(developerCount, "big"),
        }),
      ]);
    });

    await backfillCommand(CREDENTIALS);

    const counts = sentSpanCounts();
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(developerCount);
    expect(Math.max(...counts)).toBeLessThanOrEqual(10);
    expect(output()).toContain("Backfill complete!");
  });
});
