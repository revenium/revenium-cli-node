import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists } from "../config/loader.js";
import {
  GITHUB_CREDENTIAL_HINT,
  GITHUB_CREDENTIAL_MISSING_MESSAGE,
  type GithubCredentialOverrides,
  resolveGithubCredential,
} from "../config/github-credential.js";
import { fetchUsageDays } from "../core/github-client.js";
import { buildOtlpPayload, isValidDay } from "../core/transform/otlp-mapper.js";
import { computeBreakdownHash } from "../core/sync/deduplicator.js";
import { appendBreakdown } from "../core/sync/pending-days.js";
import { Deduplicator } from "../../_core/sync/deduplicator.js";
import {
  countWithheldRecords,
  createBillingReport,
  recordBillingFetch,
} from "../core/billing-match.js";
import { printBillingReport } from "../ui/billing-report.js";
import { COPILOT_METRICS_POLICY_HINT } from "../constants.js";
import { BACKFILL_DEDUP_WINDOW_RECORDS } from "../../_core/constants.js";
import { MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE } from "../../_core/api/rate-limiter.js";
import { sendTracesWithResult } from "../../_core/api/otlp-client.js";
import { startupStagger } from "../../_core/api/resilience.js";
import { FailedBatchLog, reportBackfillOutcome } from "../../_core/ui/backfill-outcome.js";
import type { CopilotUsageDay } from "../types.js";

const BILLING_REMEDY =
  "Re-run the backfill over those days once the token can read billing. Pass --allow-missing-billing to import their usage at zero cost instead.";

export interface BackfillOptions extends GithubCredentialOverrides {
  since?: string;
  to?: string;
  dryRun?: boolean;
  batchSize?: number;
  delay?: number;
  verbose?: boolean;
  allowMissingBilling?: boolean;
}

export function parseRelativeDate(input: string): Date | null {
  const match = input.match(/^(\d+)([dmwMy])$/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case "d":
      now.setDate(now.getDate() - amount);
      break;
    case "w":
      now.setDate(now.getDate() - amount * 7);
      break;
    case "m":
    case "M":
      now.setMonth(now.getMonth() - amount);
      break;
    case "y":
      now.setFullYear(now.getFullYear() - amount);
      break;
    default:
      return null;
  }

  return now;
}

export function parseSinceDate(since: string): Date | null {
  const relativeDate = parseRelativeDate(since);
  if (relativeDate) return relativeDate;

  const isoDate = new Date(since);
  if (!isNaN(isoDate.getTime())) return isoDate;

  return null;
}

function formatDateParam(date: Date): string {
  return date.toISOString().split("T")[0];
}

function printEmptyOutcome(withheldRecords: number, fetchedDayCount: number, since?: string): void {
  if (withheldRecords > 0) {
    console.log(
      chalk.yellow(
        "\nEvery record of the fetched days carries cost, and their billing data could not be read. Nothing was imported.",
      ),
    );
    return;
  }

  if (fetchedDayCount > 0) {
    console.log(chalk.yellow("\nAll fetched records were duplicates. Nothing to backfill."));
    return;
  }

  console.log(chalk.yellow("\nNo usage data found in the specified date range."));
  if (since) {
    console.log(chalk.dim("Try a broader date range or remove the --since filter."));
  }
  console.log(chalk.dim(COPILOT_METRICS_POLICY_HINT));
}

export async function backfillCommand(options: BackfillOptions = {}): Promise<void> {
  const {
    since,
    to,
    dryRun = false,
    batchSize: rawBatchSize = DEFAULT_BATCH_SIZE,
    delay = 0,
    verbose = false,
    allowMissingBilling = false,
  } = options;

  if (!Number.isInteger(rawBatchSize) || rawBatchSize < 1) {
    console.log(chalk.red("Error: --batch-size must be a positive integer"));
    process.exit(1);
  }

  const batchSize = Math.min(rawBatchSize, MAX_BATCH_SIZE);
  if (rawBatchSize > MAX_BATCH_SIZE) {
    console.log(
      chalk.yellow(
        `batch-size=${rawBatchSize} exceeds maximum of ${MAX_BATCH_SIZE}. Using ${MAX_BATCH_SIZE}.`,
      ),
    );
  }

  console.log(chalk.bold("\nRevenium GitHub Copilot Backfill\n"));

  if (dryRun) {
    console.log(chalk.yellow("Running in dry-run mode - no data will be sent\n"));
  }

  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-copilot setup` first to configure the integration."));
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  const githubCredential = resolveGithubCredential(config, options);
  if (!githubCredential) {
    console.log(chalk.red(GITHUB_CREDENTIAL_MISSING_MESSAGE));
    console.log(chalk.yellow(GITHUB_CREDENTIAL_HINT));
    process.exit(1);
  }

  let sinceDate: Date;
  if (since) {
    const parsed = parseSinceDate(since);
    if (!parsed) {
      console.log(chalk.red(`Invalid --since value: ${since}`));
      console.log(chalk.dim("Use ISO format (2024-01-15) or relative format (7d, 1m, 1y)"));
      process.exit(1);
    }
    sinceDate = parsed;
    console.log(chalk.dim(`Fetching records since: ${sinceDate.toISOString()}\n`));
  } else {
    sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 28);
    console.log(chalk.dim("No --since specified, defaulting to last 28 days (GitHub API limit)\n"));
  }

  let toDate: Date;
  if (to) {
    toDate = new Date(to);
    if (isNaN(toDate.getTime())) {
      console.log(chalk.red(`Invalid --to value: ${to}`));
      process.exit(1);
    }
  } else {
    toDate = new Date();
  }

  const spinner = ora("Fetching historical usage data from GitHub API...").start();
  const billingReport = createBillingReport();

  const deduplicator = new Deduplicator([], BACKFILL_DEDUP_WINDOW_RECORDS);
  const pendingDays: CopilotUsageDay[] = [];
  const sampleDays: CopilotUsageDay[] = [];
  const failures = new FailedBatchLog();

  const fetchedDays = new Set<string>();
  let totalBreakdowns = 0;
  let duplicateBreakdowns = 0;
  let uniqueBreakdownCount = 0;
  let totalSuggestions = 0;
  let totalAcceptances = 0;
  let pendingRecords = 0;
  let batchNumber = 0;
  let sentBatches = 0;
  let sentRecords = 0;
  let lastSentMarker: string | undefined;
  let fetchError: string | undefined;

  const progressText = (): string =>
    dryRun
      ? `Fetching usage data... (${fetchedDays.size} days so far)`
      : `Fetched ${fetchedDays.size} days, sent ${sentRecords} records in ${sentBatches} batches...`;

  const flushPending = async (): Promise<void> => {
    if (pendingDays.length === 0) return;

    const batch = pendingDays.splice(0);
    const recordCount = pendingRecords;
    pendingRecords = 0;

    if (dryRun) {
      if (verbose && sampleDays.length === 0) {
        sampleDays.push(...batch.slice(0, Math.min(batchSize, 3)));
      }
      return;
    }

    batchNumber++;

    try {
      if (batchNumber === 1) {
        await startupStagger();
      }

      const result = await sendTracesWithResult(
        config.reveniumEndpoint,
        config.reveniumApiKey,
        buildOtlpPayload(batch, config),
        { batchSize: recordCount, userDelayMs: delay },
      );

      if (result.success) {
        sentBatches++;
        sentRecords += recordCount;
        lastSentMarker = batch[batch.length - 1].day;
      } else {
        failures.record(batchNumber, result.error || "Unknown error");
      }
    } catch (error) {
      failures.record(batchNumber, error instanceof Error ? error.message : "Unknown error");
    }

    spinner.text = progressText();
  };

  try {
    for await (const usageFetch of fetchUsageDays(
      githubCredential.token,
      githubCredential.orgName,
      formatDateParam(sinceDate),
      formatDateParam(toDate),
      { allowMissingBilling },
    )) {
      recordBillingFetch(billingReport, usageFetch);
      for (const entry of usageFetch.billingUnavailable) {
        if (entry.withheldRecords > 0 || entry.zeroCostRecords > 0) {
          fetchedDays.add(entry.day);
        }
      }

      for (const day of usageFetch.days) {
        fetchedDays.add(day.day);
        if (!isValidDay(day.day)) continue;

        for (const breakdown of day.breakdown) {
          totalBreakdowns++;

          const hash = computeBreakdownHash(day, breakdown);
          if (deduplicator.isDuplicate(hash)) {
            duplicateBreakdowns++;
            continue;
          }
          deduplicator.mark(hash);

          uniqueBreakdownCount++;
          totalSuggestions += breakdown.suggestions_count;
          totalAcceptances += breakdown.acceptances_count;

          appendBreakdown(pendingDays, day, breakdown);
          pendingRecords++;

          if (pendingRecords >= batchSize) {
            await flushPending();
          }
        }
      }

      spinner.text = progressText();
    }

    await flushPending();
  } catch (error) {
    fetchError = error instanceof Error ? error.message : "Unknown error";
    await flushPending();
  }

  const withheldRecords = countWithheldRecords(billingReport);

  if (fetchError) {
    spinner.fail("Failed to fetch usage data from GitHub API");
    console.error(chalk.red(`Error: ${fetchError}`));
  } else if (withheldRecords > 0) {
    spinner.warn(
      `Fetched ${fetchedDays.size} days of usage data from GitHub API, ${withheldRecords} record(s) withheld`,
    );
  } else {
    spinner.succeed(`Fetched ${fetchedDays.size} days of usage data from GitHub API`);
  }

  if (uniqueBreakdownCount === 0) {
    if (!fetchError) {
      printEmptyOutcome(withheldRecords, fetchedDays.size, since);
    }
    printBillingReport(billingReport, BILLING_REMEDY);
    if (fetchError || (!dryRun && withheldRecords > 0)) {
      process.exitCode = 1;
    }
    return;
  }

  console.log("\n" + chalk.bold("Summary:"));
  console.log(`  Days fetched:     ${fetchedDays.size}`);
  console.log(`  Total records:    ${totalBreakdowns.toLocaleString()}`);
  console.log(`  Unique records:   ${uniqueBreakdownCount.toLocaleString()}`);
  if (duplicateBreakdowns > 0) {
    console.log(`  Duplicates:       ${duplicateBreakdowns.toLocaleString()}`);
  }
  console.log(`  Suggestions:      ${totalSuggestions.toLocaleString()}`);
  console.log(`  Acceptances:      ${totalAcceptances.toLocaleString()}`);
  if (withheldRecords > 0) {
    console.log(`  Records withheld: ${withheldRecords.toLocaleString()}`);
  }

  printBillingReport(billingReport, BILLING_REMEDY);

  if (dryRun) {
    console.log(
      "\n" +
        (fetchError
          ? chalk.red(
              "Dry run incomplete: fetching stopped mid-run, so the totals above cover only the days fetched before the error.",
            )
          : chalk.yellow("Dry run complete. Use without --dry-run to send data.")),
    );

    if (verbose && sampleDays.length > 0) {
      console.log("\n" + chalk.dim("Sample OTLP payload (first batch):"));
      console.log(chalk.dim(JSON.stringify(buildOtlpPayload(sampleDays, config), null, 2)));
    }
    if (fetchError) {
      process.exitCode = 1;
    }
    return;
  }

  const complete = reportBackfillOutcome(spinner, {
    sentRecords,
    sentBatches,
    failedBatches: failures.entries,
    omittedFailures: failures.omitted,
    lastSentMarker,
    fetchError,
    withheldRecords,
  });
  if (!complete) {
    process.exitCode = 1;
  }
  console.log("");
}
