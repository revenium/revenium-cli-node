import chalk from "chalk";
import ora from "ora";
import { configExists } from "../config/loader.js";
import { loadMigratedConfig } from "./migrated-config.js";
import { fetchEvents, getCursorMinRequestIntervalMs } from "../core/cursor-client.js";
import {
  billableCents,
  buildOtlpPayload,
  isValidTimestamp,
} from "../core/transform/otlp-mapper.js";
import { computeEventHash } from "../core/sync/deduplicator.js";
import { Deduplicator } from "../../_core/sync/deduplicator.js";
import { BACKFILL_DEDUP_WINDOW_RECORDS } from "../../_core/constants.js";
import { MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE } from "../../_core/api/rate-limiter.js";
import { sendLogsWithResult } from "../../_core/api/otlp-client.js";
import { startupStagger } from "../../_core/api/resilience.js";
import { FailedBatchLog, reportBackfillOutcome } from "../../_core/ui/backfill-outcome.js";
import { toInclusiveRangeEnd } from "../../_core/utils/date-range.js";
import type { CursorUsageEvent } from "../types.js";

export interface BackfillOptions {
  since?: string;
  to?: string;
  dryRun?: boolean;
  batchSize?: number;
  delay?: number;
  fetchDelay?: number;
  verbose?: boolean;
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

export function parseDateInput(input: string): Date | null {
  const relativeDate = parseRelativeDate(input);
  if (relativeDate) return relativeDate;

  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) return isoDate;

  return null;
}

function formatDay(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0];
}

export async function backfillCommand(options: BackfillOptions = {}): Promise<void> {
  const {
    since,
    to,
    dryRun = false,
    batchSize: rawBatchSize = DEFAULT_BATCH_SIZE,
    delay = 0,
    fetchDelay,
    verbose = false,
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

  console.log(chalk.bold("\nRevenium Cursor IDE Backfill\n"));

  if (dryRun) {
    console.log(chalk.yellow("Running in dry-run mode - no data will be sent\n"));
  }

  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-cursor setup` first to configure the integration."));
    process.exit(1);
  }

  const config = await loadMigratedConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  let fromMs: number;
  if (since) {
    const sinceDate = parseDateInput(since);
    if (!sinceDate) {
      console.log(chalk.red(`Invalid --since value: ${since}`));
      console.log(chalk.dim("Use ISO format (2024-01-15) or relative format (7d, 1m, 1y)"));
      process.exit(1);
    }
    fromMs = sinceDate.getTime();
    console.log(chalk.dim(`Fetching records since: ${sinceDate.toISOString()}\n`));
  } else {
    fromMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    console.log(chalk.dim("No --since specified, defaulting to last 30 days\n"));
  }

  let toMs: number;
  if (to) {
    const parsedTo = parseDateInput(to);
    if (!parsedTo) {
      console.log(chalk.red(`Invalid --to value: ${to}`));
      console.log(chalk.dim("Use ISO format (2024-01-15) or relative format (7d, 1m, 1y)"));
      process.exit(1);
    }
    const toDate = toInclusiveRangeEnd(to, parsedTo);
    toMs = toDate.getTime();
    console.log(chalk.dim(`Fetching records until: ${toDate.toISOString()}\n`));
  } else {
    toMs = Date.now();
  }

  if (fromMs > toMs) {
    console.log(chalk.red("Invalid range: --since is after --to"));
    process.exit(1);
  }

  const fetchIntervalMs = fetchDelay ?? getCursorMinRequestIntervalMs();
  if (fetchIntervalMs <= 0) {
    console.log(chalk.dim("Cursor API fetch pacing disabled (--fetch-delay 0). Risk of 429s.\n"));
  } else {
    console.log(
      chalk.dim(
        `Pacing Cursor API requests to ~${(60000 / fetchIntervalMs).toFixed(1)} req/min ` +
          `(min ${fetchIntervalMs}ms between requests) to respect Cursor's rate limits.\n`,
      ),
    );
  }

  const spinner = ora("Fetching historical events from Cursor API...").start();

  const deduplicator = new Deduplicator([], BACKFILL_DEDUP_WINDOW_RECORDS);
  const pending: CursorUsageEvent[] = [];
  const sampleEvents: CursorUsageEvent[] = [];
  const failures = new FailedBatchLog();

  let fetchedCount = 0;
  let duplicateCount = 0;
  let invalidTimestampCount = 0;
  let sendableCount = 0;
  let totalTokens = 0;
  let totalCostCents = 0;
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = 0;
  let batchNumber = 0;
  let sentBatches = 0;
  let sentRecords = 0;
  let fetchError: string | undefined;

  const progressText = (): string =>
    dryRun
      ? `Fetching events... (${fetchedCount} so far)`
      : `Fetched ${fetchedCount} events, sent ${sentRecords} records in ${sentBatches} batches...`;

  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;

    const batch = pending.splice(0);

    if (dryRun) {
      if (verbose && sampleEvents.length === 0) {
        sampleEvents.push(...batch.slice(0, Math.min(batchSize, 3)));
      }
      return;
    }

    batchNumber++;

    try {
      if (batchNumber === 1) {
        await startupStagger();
      }

      const result = await sendLogsWithResult(
        config.reveniumEndpoint,
        config.reveniumApiKey,
        buildOtlpPayload(batch, config),
        { batchSize: batch.length, userDelayMs: delay },
      );

      if (result.success) {
        sentBatches++;
        sentRecords += batch.length;
      } else {
        failures.record(batchNumber, result.error || "Unknown error");
      }
    } catch (error) {
      failures.record(batchNumber, error instanceof Error ? error.message : "Unknown error");
    }

    spinner.text = progressText();
  };

  try {
    for await (const page of fetchEvents(config.cursorApiKey, fromMs, toMs, {
      minRequestIntervalMs: fetchDelay,
    })) {
      for (const event of page) {
        fetchedCount++;

        const hash = computeEventHash(event);
        if (deduplicator.isDuplicate(hash)) {
          duplicateCount++;
          continue;
        }
        deduplicator.mark(hash);

        if (!isValidTimestamp(event.timestamp)) {
          invalidTimestampCount++;
          continue;
        }

        sendableCount++;
        totalTokens +=
          (event.tokenUsage?.inputTokens ?? 0) +
          (event.tokenUsage?.outputTokens ?? 0) +
          (event.tokenUsage?.cacheReadTokens ?? 0) +
          (event.tokenUsage?.cacheWriteTokens ?? 0);
        totalCostCents += billableCents(event);
        firstTimestamp = Math.min(firstTimestamp, event.timestamp);
        lastTimestamp = Math.max(lastTimestamp, event.timestamp);

        pending.push(event);
        if (pending.length >= batchSize) {
          await flushPending();
        }
      }

      spinner.text = progressText();
    }

    await flushPending();
  } catch (error) {
    fetchError = error instanceof Error ? error.message : "Unknown error";
    await flushPending();
  }

  if (fetchError) {
    spinner.fail("Failed to fetch events from Cursor API");
    console.error(chalk.red(`Error: ${fetchError}`));
  } else {
    spinner.succeed(`Fetched ${fetchedCount} events from Cursor API`);
  }

  if (sendableCount === 0) {
    if (fetchedCount === 0) {
      console.log(chalk.yellow("\nNo events found in the specified date range."));
      if (since) {
        console.log(chalk.dim("Try a broader date range or remove the --since filter."));
      }
    } else if (duplicateCount === fetchedCount) {
      console.log(chalk.yellow("\nAll fetched events were duplicates. Nothing to backfill."));
    } else {
      console.log(
        chalk.yellow("\nAll unique events have invalid timestamps. Nothing to backfill."),
      );
    }
    if (fetchError) {
      process.exitCode = 1;
    }
    return;
  }

  console.log("\n" + chalk.bold("Summary:"));
  console.log(`  Total events:     ${fetchedCount.toLocaleString()}`);
  console.log(`  Unique events:    ${(fetchedCount - duplicateCount).toLocaleString()}`);
  if (duplicateCount > 0) {
    console.log(`  Duplicates:       ${duplicateCount.toLocaleString()}`);
  }
  if (invalidTimestampCount > 0) {
    console.log(`  Invalid timestamps: ${invalidTimestampCount.toLocaleString()} (skipped)`);
  }
  console.log(`  Sendable events:  ${sendableCount.toLocaleString()}`);
  console.log(`  Date range:       ${formatDay(firstTimestamp)} to ${formatDay(lastTimestamp)}`);
  console.log(`  Total tokens:     ${totalTokens.toLocaleString()}`);
  console.log(`  Total cost:       $${(totalCostCents / 100).toFixed(2)}`);

  if (dryRun) {
    console.log(
      "\n" +
        (fetchError
          ? chalk.red(
              "Dry run incomplete: fetching stopped mid-run, so the totals above cover only the events fetched before the error.",
            )
          : chalk.yellow("Dry run complete. Use without --dry-run to send data.")),
    );

    if (verbose && sampleEvents.length > 0) {
      console.log("\n" + chalk.dim("Sample OTLP payload (first batch):"));
      console.log(chalk.dim(JSON.stringify(buildOtlpPayload(sampleEvents, config), null, 2)));
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
    fetchError,
  });
  if (!complete) {
    process.exitCode = 1;
  }
  console.log("");
}
