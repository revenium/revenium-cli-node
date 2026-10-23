import type {
  BillingReport,
  BillingUsageItem,
  CopilotUsageBreakdown,
  CopilotUsageFetch,
  UnmatchedBillingLine,
} from "../types.js";
import { UNKNOWN_EDITOR, UNKNOWN_LANGUAGE, UNKNOWN_MODEL } from "../constants.js";

export function toModelName(model: string): string {
  return model
    .replace(/^Auto:\s*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function toModelKey(model: string): string {
  return toModelName(model).replace(/-/g, "");
}

function billableAmount(item: BillingUsageItem): number {
  return item.netAmount ?? item.grossAmount;
}

export function isCostBearing(breakdown: CopilotUsageBreakdown): boolean {
  return breakdown.surface === undefined;
}

export function createBillingReport(): BillingReport {
  return { unmatched: [], unavailable: [] };
}

export function recordBillingFetch(report: BillingReport, fetch: CopilotUsageFetch): void {
  report.unmatched.push(...fetch.unmatchedBilling);
  report.unavailable.push(...fetch.billingUnavailable);
}

export function countWithheldRecords(report: BillingReport): number {
  return report.unavailable.reduce((sum, entry) => sum + entry.withheldRecords, 0);
}

export function countZeroCostRecords(report: BillingReport): number {
  return report.unavailable.reduce((sum, entry) => sum + entry.zeroCostRecords, 0);
}

export function applyBillingToBreakdowns(
  breakdowns: CopilotUsageBreakdown[],
  billingItems: BillingUsageItem[],
  day: string,
): UnmatchedBillingLine[] {
  const chatRows = breakdowns.filter(isCostBearing);

  const rowsPerKey = new Map<string, number>();
  for (const breakdown of chatRows) {
    const key = toModelKey(breakdown.model);
    rowsPerKey.set(key, (rowsPerKey.get(key) ?? 0) + 1);
  }

  const costPerKey = new Map<string, number>();
  const unmatchedPerModel = new Map<string, UnmatchedBillingLine>();

  for (const item of billingItems) {
    const model = item.model ?? UNKNOWN_MODEL;
    const key = toModelKey(model);
    const amount = billableAmount(item);

    if (rowsPerKey.has(key)) {
      costPerKey.set(key, (costPerKey.get(key) ?? 0) + amount);
      continue;
    }

    const existing = unmatchedPerModel.get(model);
    if (existing) {
      existing.cost_usd += amount;
    } else {
      unmatchedPerModel.set(model, { day, model, cost_usd: amount });
    }
  }

  for (const breakdown of chatRows) {
    const key = toModelKey(breakdown.model);
    breakdown.cost_usd = (costPerKey.get(key) ?? 0) / (rowsPerKey.get(key) ?? 1);
  }

  return Array.from(unmatchedPerModel.values());
}

function buildBillingOnlyBreakdown(model: string, cost: number): CopilotUsageBreakdown {
  return {
    language: UNKNOWN_LANGUAGE,
    editor: UNKNOWN_EDITOR,
    model,
    user_login: "",
    cost_usd: cost,
    suggestions_count: 0,
    acceptances_count: 0,
    lines_suggested: 0,
    lines_accepted: 0,
    active_users: 0,
    input_tokens: 0,
    output_tokens: 0,
    ai_credits: 0,
    surface: "billing",
  };
}

export function createBillingOnlyBreakdowns(
  lines: UnmatchedBillingLine[],
): CopilotUsageBreakdown[] {
  const costPerModel = new Map<string, number>();
  for (const line of lines) {
    const model = toModelName(line.model);
    costPerModel.set(model, (costPerModel.get(model) ?? 0) + line.cost_usd);
  }

  return Array.from(costPerModel, ([model, cost]) => buildBillingOnlyBreakdown(model, cost));
}

export function clearCostsAlreadyImportedAsBilling(
  breakdowns: CopilotUsageBreakdown[],
  wasImported: (breakdown: CopilotUsageBreakdown) => boolean,
): void {
  const importedPerModel = new Map<string, boolean>();

  for (const breakdown of breakdowns) {
    if (!isCostBearing(breakdown) || breakdown.cost_usd === 0) continue;

    const model = toModelName(breakdown.model);
    let imported = importedPerModel.get(model);

    if (imported === undefined) {
      imported = wasImported(buildBillingOnlyBreakdown(model, 0));
      importedPerModel.set(model, imported);
    }

    if (imported) breakdown.cost_usd = 0;
  }
}
