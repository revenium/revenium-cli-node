import chalk from "chalk";
import { countWithheldRecords, countZeroCostRecords } from "../core/billing-match.js";
import type { BillingReport, BillingUnavailableDay, UnmatchedBillingLine } from "../types.js";

function formatUnmatchedLine(line: UnmatchedBillingLine): string {
  return `  ${line.day}  ${line.model}  $${line.cost_usd.toFixed(2)}`;
}

function totalCost(lines: UnmatchedBillingLine[]): number {
  return lines.reduce((sum, line) => sum + line.cost_usd, 0);
}

function formatImpact(entry: BillingUnavailableDay): string {
  if (entry.zeroCostRecords > 0) {
    return `${entry.zeroCostRecords} record(s) allowed through without billing data`;
  }
  return `${entry.withheldRecords} record(s) withheld`;
}

function summarizeImpact(report: BillingReport, remedy: string): string {
  const withheldRecords = countWithheldRecords(report);
  if (withheldRecords > 0) {
    return `Those records were not sent, so Revenium holds no zero-cost row for them. ${remedy}`;
  }

  const zeroCostRecords = countZeroCostRecords(report);
  if (zeroCostRecords > 0) {
    return `${zeroCostRecords} record(s) were allowed through without billing data because --allow-missing-billing was passed; any of them that is not a duplicate reaches Revenium at zero cost, which is not a measured zero.`;
  }

  return "No cost-bearing record was affected, so nothing was withheld.";
}

export function printBillingReport(report: BillingReport, remedy: string): void {
  if (report.unmatched.length > 0) {
    console.log(
      "\n" +
        chalk.yellow.bold(
          "Unmatched billing lines (organization-level records, no developer attribution):",
        ),
    );
    for (const line of report.unmatched) {
      console.log(chalk.yellow(formatUnmatchedLine(line)));
    }
    console.log(
      chalk.yellow(
        `  Total without developer attribution: $${totalCost(report.unmatched).toFixed(2)}`,
      ),
    );
    console.log(
      chalk.dim(
        "  Each line is imported once, at the amount first seen; a later revision is not re-imported.",
      ),
    );
  }

  if (report.unavailable.length > 0) {
    console.log("\n" + chalk.red.bold("Billing data unavailable:"));
    for (const entry of report.unavailable) {
      console.log(chalk.red(`  ${entry.day}  ${formatImpact(entry)}`));
      console.log(chalk.red(`    ${entry.reason}`));
    }
    console.log(chalk.dim(summarizeImpact(report, remedy)));
  }
}

export function createBillingReportPrinter(remedy: string): (report: BillingReport) => void {
  const printed = new Set<string>();

  const isNew = (key: string): boolean => {
    if (printed.has(key)) return false;
    printed.add(key);
    return true;
  };

  return (report) =>
    printBillingReport(
      {
        unmatched: report.unmatched.filter((line) =>
          isNew(`${line.day}|${line.model}|${line.cost_usd}`),
        ),
        unavailable: report.unavailable.filter((entry) =>
          isNew(`unavailable|${entry.day}|${entry.reason}`),
        ),
      },
      remedy,
    );
}
