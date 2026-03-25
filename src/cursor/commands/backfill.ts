import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists } from "../config/loader.js";
import { fetchEvents } from "../core/cursor-client.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { buildOtlpPayload, isValidTimestamp } from "../core/transform/otlp-mapper.js";
import { computeEventHash, Deduplicator } from "../core/sync/deduplicator.js";
import {
  createRateLimiterState,
  enforceRateLimit,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} from "../../_core/api/rate-limiter.js";
import type { CursorUsageEvent } from "../types.js";

export interface BackfillOptions {
  since?: string;
  to?: string;
  dryRun?: boolean;
  batchSize?: number;
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

export function parseSinceDate(since: string): Date | null {
  const relativeDate = parseRelativeDate(since);
  if (relativeDate) return relativeDate;

  const isoDate = new Date(since);
  if (!isNaN(isoDate.getTime())) return isoDate;

  return null;
}

export async function backfillCommand(options: BackfillOptions = {}): Promise<void> {
  const {
    since,
    to,
    dryRun = false,
    batchSize: rawBatchSize = DEFAULT_BATCH_SIZE,
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

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  let fromMs: number;
  if (since) {
    const sinceDate = parseSinceDate(since);
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
    const toDate = new Date(to);
    if (isNaN(toDate.getTime())) {
      console.log(chalk.red(`Invalid --to value: ${to}`));
      process.exit(1);
    }
    toMs = toDate.getTime();
  } else {
    toMs = Date.now();
  }

  const fetchSpinner = ora("Fetching historical events from Cursor API...").start();
  const allEvents: CursorUsageEvent[] = [];

  try {
    for await (const batch of fetchEvents(config.cursorApiKey, fromMs, toMs)) {
      allEvents.push(...batch);
      fetchSpinner.text = `Fetching events... (${allEvents.length} so far)`;
    }
    fetchSpinner.succeed(`Fetched ${allEvents.length} events from Cursor API`);
  } catch (error) {
    fetchSpinner.fail("Failed to fetch events from Cursor API");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  if (allEvents.length === 0) {
    console.log(chalk.yellow("\nNo events found in the specified date range."));
    if (since) {
      console.log(chalk.dim("Try a broader date range or remove the --since filter."));
    }
    return;
  }

  const deduplicator = new Deduplicator([]);
  const uniqueEvents: CursorUsageEvent[] = [];
  let duplicateCount = 0;

  for (const event of allEvents) {
    const hash = computeEventHash(event);
    if (deduplicator.isDuplicate(hash)) {
      duplicateCount++;
      continue;
    }
    deduplicator.mark(hash);
    uniqueEvents.push(event);
  }

  if (uniqueEvents.length === 0) {
    console.log(chalk.yellow("\nAll fetched events were duplicates. Nothing to backfill."));
    return;
  }

  const invalidTimestampCount = uniqueEvents.filter((e) => !isValidTimestamp(e.timestamp)).length;
  const sendableEvents = uniqueEvents.filter((e) => isValidTimestamp(e.timestamp));

  if (sendableEvents.length === 0) {
    console.log(chalk.yellow("\nAll unique events have invalid timestamps. Nothing to backfill."));
    return;
  }

  const timestamps = sendableEvents.map((e) => e.timestamp).sort((a, b) => a - b);
  const totalTokens = sendableEvents.reduce(
    (sum, e) =>
      sum +
      (e.tokenUsage?.inputTokens ?? 0) +
      (e.tokenUsage?.outputTokens ?? 0) +
      (e.tokenUsage?.cacheReadTokens ?? 0) +
      (e.tokenUsage?.cacheWriteTokens ?? 0),
    0,
  );
  const totalCostCents = sendableEvents.reduce(
    (sum, e) => sum + (e.tokenUsage?.totalCents ?? 0),
    0,
  );

  console.log("\n" + chalk.bold("Summary:"));
  console.log(`  Total events:     ${allEvents.length.toLocaleString()}`);
  console.log(`  Unique events:    ${uniqueEvents.length.toLocaleString()}`);
  if (duplicateCount > 0) {
    console.log(`  Duplicates:       ${duplicateCount.toLocaleString()}`);
  }
  if (invalidTimestampCount > 0) {
    console.log(`  Invalid timestamps: ${invalidTimestampCount.toLocaleString()} (skipped)`);
  }
  console.log(`  Sendable events:  ${sendableEvents.length.toLocaleString()}`);
  if (timestamps.length > 0) {
    console.log(
      `  Date range:       ${new Date(timestamps[0]).toISOString().split("T")[0]} to ${new Date(timestamps[timestamps.length - 1]).toISOString().split("T")[0]}`,
    );
  }
  console.log(`  Total tokens:     ${totalTokens.toLocaleString()}`);
  console.log(`  Total cost:       $${(totalCostCents / 100).toFixed(2)}`);

  if (dryRun) {
    console.log("\n" + chalk.yellow("Dry run complete. Use without --dry-run to send data."));

    if (verbose) {
      console.log("\n" + chalk.dim("Sample OTLP payload (first batch):"));
      const sampleEvents = sendableEvents.slice(0, Math.min(batchSize, 3));
      const samplePayload = buildOtlpPayload(sampleEvents, config);
      console.log(chalk.dim(JSON.stringify(samplePayload, null, 2)));
    }
    return;
  }

  const totalBatches = Math.ceil(sendableEvents.length / batchSize);
  const sendSpinner = ora(`Sending data... (0/${totalBatches} batches)`).start();
  let sentBatches = 0;
  let sentRecords = 0;
  let failedBatches = 0;
  const rateLimiterState = createRateLimiterState();

  for (let i = 0; i < sendableEvents.length; i += batchSize) {
    const batch = sendableEvents.slice(i, i + batchSize);
    const payload = buildOtlpPayload(batch, config);

    await enforceRateLimit(rateLimiterState, { batchSize: batch.length });
    sendSpinner.text = `Sending batch ${sentBatches + failedBatches + 1}/${totalBatches}...`;

    try {
      await sendOtlpLogs(config.reveniumEndpoint, config.reveniumApiKey, payload);
      sentBatches++;
      sentRecords += batch.length;
    } catch {
      failedBatches++;
    }
  }

  if (failedBatches === 0) {
    sendSpinner.succeed(`Sent ${sentRecords.toLocaleString()} records in ${sentBatches} batches`);
  } else {
    sendSpinner.warn(
      `Sent ${sentRecords.toLocaleString()} records in ${sentBatches} batches (${failedBatches} failed)`,
    );
  }

  console.log("\n" + chalk.green.bold("Backfill complete!"));
  console.log(chalk.dim("Check your Revenium dashboard to see the imported data."));
  console.log("");
}
