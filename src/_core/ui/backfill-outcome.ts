import chalk from "chalk";
import type { Ora } from "ora";

const MAX_REPORTED_FAILED_BATCHES = 100;

export interface FailedBatch {
  batchNumber: number;
  error: string;
}

export class FailedBatchLog {
  private readonly reported: FailedBatch[] = [];
  private omittedCount = 0;

  constructor(private readonly capacity: number = MAX_REPORTED_FAILED_BATCHES) {}

  record(batchNumber: number, error: string): void {
    if (this.reported.length < this.capacity) {
      this.reported.push({ batchNumber, error });
      return;
    }
    this.omittedCount++;
  }

  get entries(): FailedBatch[] {
    return this.reported;
  }

  get omitted(): number {
    return this.omittedCount;
  }
}

export interface BackfillOutcome {
  sentRecords: number;
  sentBatches: number;
  failedBatches: FailedBatch[];
  omittedFailures?: number;
  lastSentMarker?: string;
  fetchError?: string;
  withheldRecords?: number;
}

export function reportBackfillOutcome(spinner: Ora, outcome: BackfillOutcome): boolean {
  const {
    sentRecords,
    sentBatches,
    failedBatches,
    omittedFailures = 0,
    lastSentMarker,
    fetchError,
    withheldRecords = 0,
  } = outcome;
  const summary = `Sent ${sentRecords.toLocaleString()} records in ${sentBatches} batches`;
  const failedCount = failedBatches.length + omittedFailures;

  if (failedCount === 0 && !fetchError && withheldRecords === 0) {
    spinner.succeed(summary);
    console.log("\n" + chalk.green.bold("Backfill complete!"));
    console.log(chalk.dim("Check your Revenium dashboard to see the imported data."));
    return true;
  }

  spinner.warn(failedCount > 0 ? `${summary} (${failedCount} failed)` : summary);

  if (failedCount > 0) {
    console.log("\n" + chalk.red.bold("Failed Batches:"));
    for (const failed of failedBatches) {
      console.log(chalk.red(`  Batch ${failed.batchNumber}: ${failed.error}`));
    }
    if (omittedFailures > 0) {
      console.log(chalk.red(`  ...and ${omittedFailures.toLocaleString()} more failed batch(es)`));
    }

    console.log(
      "\n" + chalk.red.bold(`Backfill incomplete: ${failedCount} batch(es) were not sent.`),
    );
  } else if (fetchError) {
    console.log(
      "\n" + chalk.red.bold("Backfill incomplete: the source stopped returning data mid-run."),
    );

    if (lastSentMarker) {
      console.log(chalk.yellow(`Resume from: ${lastSentMarker}`));
    }
  } else {
    console.log(
      "\n" +
        chalk.red.bold(
          `Backfill incomplete: ${withheldRecords.toLocaleString()} record(s) were withheld because their cost could not be read.`,
        ),
    );
    return false;
  }

  console.log(
    chalk.yellow(
      "Re-run the same window to finish the import: every record is re-sent with the transaction_id it already had.",
    ),
  );

  return false;
}
