import { describe, it, expect } from "vitest";
import {
  applyBillingToBreakdowns,
  clearCostsAlreadyImportedAsBilling,
  createBillingOnlyBreakdowns,
  toModelKey,
} from "../../../src/copilot/core/billing-match.js";
import { computeBreakdownHash } from "../../../src/copilot/core/sync/deduplicator.js";
import { Deduplicator } from "../../../src/_core/sync/deduplicator.js";
import {
  createBillingUsageItem,
  createCopilotBreakdown,
  createCopilotUsageDay,
} from "../../helpers/fixtures.js";
import type { CopilotUsageBreakdown } from "../../../src/copilot/types.js";

const DAY = "2026-06-03";

function createBreakdown(model: string, user_login = "alice"): CopilotUsageBreakdown {
  return createCopilotBreakdown({
    model,
    user_login,
    suggestions_count: 2,
    acceptances_count: 1,
    lines_suggested: 10,
    lines_accepted: 8,
    active_users: 1,
  });
}

describe("toModelKey", () => {
  it("folds spacing and hyphenation differences onto one key", () => {
    expect(toModelKey("Claude Sonnet 4.6")).toBe(toModelKey("claude-sonnet-4.6"));
    expect(toModelKey("Gemini 3 Pro")).toBe(toModelKey("gemini-3-pro"));
  });

  it("strips the Auto prefix", () => {
    expect(toModelKey("Auto: Claude Sonnet 5")).toBe(toModelKey("claude-sonnet-5"));
  });

  it("keeps version separators significant", () => {
    expect(toModelKey("gpt-4.1")).not.toBe(toModelKey("gpt-41"));
  });
});

describe("applyBillingToBreakdowns", () => {
  it("assigns billing cost to multi-word model names", () => {
    const breakdowns = [createBreakdown("claude-sonnet-4.6"), createBreakdown("gpt-5")];
    const billing = [
      createBillingUsageItem("Claude Sonnet 4.6", 2.5),
      createBillingUsageItem("GPT-5", 1),
    ];

    const unmatched = applyBillingToBreakdowns(breakdowns, billing, DAY);

    expect(breakdowns[0].cost_usd).toBe(2.5);
    expect(breakdowns[1].cost_usd).toBe(1);
    expect(breakdowns.reduce((sum, b) => sum + b.cost_usd, 0)).toBeCloseTo(3.5);
    expect(unmatched).toEqual([]);
  });

  it("reports billing lines without a usage row using GitHub's own spelling", () => {
    const breakdowns = [createBreakdown("gpt-5")];
    const billing = [createBillingUsageItem("Gemini 3 Pro", 4)];

    const unmatched = applyBillingToBreakdowns(breakdowns, billing, DAY);

    expect(breakdowns[0].cost_usd).toBe(0);
    expect(unmatched).toEqual([{ day: DAY, model: "Gemini 3 Pro", cost_usd: 4 }]);
  });

  it("splits a model's cost evenly across its rows and preserves the total", () => {
    const breakdowns = [
      createBreakdown("claude-sonnet-4.6", "alice"),
      createBreakdown("claude-sonnet-4.6", "bob"),
    ];
    const billing = [createBillingUsageItem("Claude Sonnet 4.6", 2.5)];

    applyBillingToBreakdowns(breakdowns, billing, DAY);

    expect(breakdowns[0].cost_usd).toBe(1.25);
    expect(breakdowns[1].cost_usd).toBe(1.25);
    expect(breakdowns.reduce((sum, b) => sum + b.cost_usd, 0)).toBeCloseTo(2.5);
  });

  it("reports every billing line when the day has no usage rows", () => {
    const unmatched = applyBillingToBreakdowns(
      [],
      [createBillingUsageItem("Auto: Gemini 3 Pro", 4)],
      DAY,
    );

    expect(unmatched).toEqual([{ day: DAY, model: "Auto: Gemini 3 Pro", cost_usd: 4 }]);
  });

  it("leaves usage models without a billing line at zero cost", () => {
    const breakdowns = [createBreakdown("gpt-5")];

    const unmatched = applyBillingToBreakdowns(breakdowns, [], DAY);

    expect(breakdowns[0].cost_usd).toBe(0);
    expect(unmatched).toEqual([]);
  });

  it("excludes plan-included usage from the imported cost", () => {
    const breakdowns = [createBreakdown("claude-sonnet-4.6")];
    const billing = [
      { ...createBillingUsageItem("Claude Sonnet 4.6", 2.5), discountAmount: 2.5, netAmount: 0 },
    ];

    applyBillingToBreakdowns(breakdowns, billing, DAY);

    expect(breakdowns[0].cost_usd).toBe(0);
  });

  it("keeps each vendor spelling on its own unmatched line", () => {
    const billing = [
      createBillingUsageItem("Auto: Gemini 3 Pro", 4),
      createBillingUsageItem("Gemini 3 Pro", 1),
    ];

    const unmatched = applyBillingToBreakdowns([], billing, DAY);

    expect(unmatched).toEqual([
      { day: DAY, model: "Auto: Gemini 3 Pro", cost_usd: 4 },
      { day: DAY, model: "Gemini 3 Pro", cost_usd: 1 },
    ]);
  });

  it("reports a billing line without a model instead of failing", () => {
    const billing = [{ ...createBillingUsageItem("", 4), model: undefined }];

    const unmatched = applyBillingToBreakdowns([], billing, DAY);

    expect(unmatched).toEqual([{ day: DAY, model: "unknown", cost_usd: 4 }]);
  });

  it("excludes surface rows from the per-model split", () => {
    const chatRow = createBreakdown("claude-sonnet-4.6");
    const cliRow = createCopilotBreakdown({ model: "claude-sonnet-4.6", surface: "cli" });

    applyBillingToBreakdowns(
      [chatRow, cliRow],
      [createBillingUsageItem("Claude Sonnet 4.6", 2.5)],
      DAY,
    );

    expect(chatRow.cost_usd).toBe(2.5);
    expect(cliRow.cost_usd).toBe(0);
  });
});

describe("createBillingOnlyBreakdowns", () => {
  it("turns a billed model with no usage row into an organization-level record", () => {
    const rows = createBillingOnlyBreakdowns([
      { day: DAY, model: "claude-sonnet-4.5", cost_usd: 0.5 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBe(0.5);
    expect(rows[0].user_login).toBe("");
    expect(rows[0].surface).toBe("billing");
    expect(rows[0].model).toBe("claude-sonnet-4.5");
  });

  it("sums two vendor spellings of the same model into a single record", () => {
    const rows = createBillingOnlyBreakdowns([
      { day: DAY, model: "Auto: Gemini 3 Pro", cost_usd: 4 },
      { day: DAY, model: "Gemini 3 Pro", cost_usd: 1 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gemini-3-pro");
    expect(rows[0].cost_usd).toBe(5);
  });

  it("records GitHub's billing spelling under the model name used by usage rows", () => {
    const rows = createBillingOnlyBreakdowns([
      { day: DAY, model: "Auto: Claude Sonnet 4.6", cost_usd: 2 },
    ]);

    expect(rows[0].model).toBe("claude-sonnet-4.6");
  });
});

describe("clearCostsAlreadyImportedAsBilling", () => {
  function runImport(deduplicator: Deduplicator, users: string[]): number {
    const day = createCopilotUsageDay({ day: DAY, breakdown: [] });
    day.breakdown = users.map((user) => createBreakdown("claude-sonnet-4.6", user));

    const billing = [createBillingUsageItem("Claude Sonnet 4.6", 3)];
    const unmatched = applyBillingToBreakdowns(day.breakdown, billing, DAY);
    day.breakdown.push(...createBillingOnlyBreakdowns(unmatched));

    clearCostsAlreadyImportedAsBilling(day.breakdown, (breakdown) =>
      deduplicator.isDuplicate(computeBreakdownHash(day, breakdown)),
    );

    let imported = 0;
    for (const breakdown of day.breakdown) {
      const hash = computeBreakdownHash(day, breakdown);
      if (deduplicator.isDuplicate(hash)) continue;
      deduplicator.mark(hash);
      imported += breakdown.cost_usd;
    }

    return imported;
  }

  it("charges a day's cost once when metrics arrive after a billing-only import", () => {
    const deduplicator = new Deduplicator([]);

    const billingOnlyRun = runImport(deduplicator, []);
    const laterMetricsRun = runImport(deduplicator, ["alice", "bob"]);

    expect(billingOnlyRun).toBe(3);
    expect(laterMetricsRun).toBe(0);
  });

  it("keeps the cost on developer rows when no billing-only record was imported", () => {
    const deduplicator = new Deduplicator([]);

    expect(runImport(deduplicator, ["alice", "bob"])).toBeCloseTo(3);
  });
});
