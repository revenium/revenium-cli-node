import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createBillingReportPrinter,
  printBillingReport,
} from "../../../src/copilot/ui/billing-report.js";
import { createBillingReport } from "../../../src/copilot/core/billing-match.js";
import { BILLING_PERMISSION_HINT } from "../../../src/copilot/constants.js";
import type { BillingReport } from "../../../src/copilot/types.js";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function output(): string {
  return logSpy.mock.calls
    .map(([line]) => String(line))
    .join("\n")
    .replace(/\[\d+m/g, "");
}

const REMEDY = "run `revenium-copilot reset` so these days are imported again on the next sync.";

function reportWith(overrides: Partial<BillingReport>): BillingReport {
  return { ...createBillingReport(), ...overrides };
}

describe("printBillingReport", () => {
  it("names each unmatched billing line with GitHub's spelling, its day and its amount", () => {
    printBillingReport(
      reportWith({
        unmatched: [
          { day: "2026-06-03", model: "Auto: Gemini 3 Pro", cost_usd: 4 },
          { day: "2026-06-04", model: "Claude Sonnet 4.6", cost_usd: 2.5 },
        ],
      }),
      REMEDY,
    );

    const text = output();
    expect(text).toContain("2026-06-03");
    expect(text).toContain("Auto: Gemini 3 Pro");
    expect(text).toContain("$4.00");
    expect(text).toContain("2026-06-04");
    expect(text).toContain("Claude Sonnet 4.6");
    expect(text).toContain("$2.50");
    expect(text).toContain("Total without developer attribution: $6.50");
    expect(text).toContain("at the amount first seen");
  });

  it("names the days whose billing data could not be read, with the reason and what was withheld", () => {
    printBillingReport(
      reportWith({
        unavailable: [
          {
            day: "2026-06-03",
            reason: `GitHub API 403 Forbidden - denied ${BILLING_PERMISSION_HINT}`,
            withheldRecords: 7,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      }),
      REMEDY,
    );

    const text = output();
    expect(text).toContain("Billing data unavailable");
    expect(text).toContain("2026-06-03");
    expect(text).toContain("403 Forbidden");
    expect(text).toContain("Administration (read-only)");
    expect(text).toContain("Copilot usage metrics");
    expect(text).toContain("7 record(s) withheld");
    expect(text).toContain("Revenium holds no zero-cost row for them");
    expect(text).toContain(REMEDY);
  });

  it("does not offer a remedy when the failure withheld no record", () => {
    printBillingReport(
      reportWith({
        unavailable: [
          {
            day: "2026-06-03",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      }),
      REMEDY,
    );

    const text = output();
    expect(text).toContain("Billing data unavailable");
    expect(text).toContain("No cost-bearing record was affected");
    expect(text).not.toContain(REMEDY);
  });

  it("separates records imported at zero cost from a day with nothing at stake", () => {
    printBillingReport(
      reportWith({
        unavailable: [
          {
            day: "2026-06-03",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 5,
            unresolved: false,
          },
        ],
      }),
      REMEDY,
    );

    const text = output();
    expect(text).toContain("5 record(s) allowed through without billing data");
    expect(text).toContain("--allow-missing-billing");
    expect(text).toContain("not a measured zero");
    expect(text).not.toContain("No cost-bearing record was affected");
    expect(text).not.toContain(REMEDY);
  });

  it("prints nothing when every billing line matched a usage row", () => {
    printBillingReport(createBillingReport(), REMEDY);

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("createBillingReportPrinter", () => {
  it("reports a line once across watch cycles and still reports a newly seen one", () => {
    const print = createBillingReportPrinter(REMEDY);
    const first = { day: "2026-06-03", model: "Gemini 3 Pro", cost_usd: 4 };
    const second = { day: "2026-06-04", model: "Gemini 3 Pro", cost_usd: 1 };

    const unavailable = {
      day: "2026-06-03",
      reason: "GitHub API 403",
      withheldRecords: 2,
      zeroCostRecords: 0,
      unresolved: true,
    };
    const laterUnavailable = {
      day: "2026-06-04",
      reason: "GitHub API 403",
      withheldRecords: 1,
      zeroCostRecords: 0,
      unresolved: true,
    };

    print({ unmatched: [first], unavailable: [unavailable] });
    logSpy.mockClear();
    print({ unmatched: [first, second], unavailable: [unavailable, laterUnavailable] });

    const text = output();
    expect(text).toContain("2026-06-04");
    expect(text).toContain("$1.00");
    expect(text.match(/2026-06-03/g)).toBeNull();
  });

  it("prints nothing on a cycle that repeats only already reported lines", () => {
    const print = createBillingReportPrinter(REMEDY);
    const line = { day: "2026-06-03", model: "Gemini 3 Pro", cost_usd: 4 };

    print({ unmatched: [line], unavailable: [] });
    logSpy.mockClear();
    print({ unmatched: [line], unavailable: [] });

    expect(logSpy).not.toHaveBeenCalled();
  });
});
