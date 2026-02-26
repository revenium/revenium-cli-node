#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { testCommand } from "../commands/test.js";
import { syncCommand } from "../commands/sync.js";
import { resetCommand } from "../commands/reset.js";
import { backfillCommand } from "../commands/backfill.js";
import pkg from "../../../package.json";

export const program = new Command();

program
  .name("revenium-cursor")
  .description("Sync Cursor IDE usage telemetry to Revenium")
  .version(pkg.version);

program
  .command("setup")
  .description("Interactive setup wizard to configure Cursor IDE metering")
  .option("--cursor-api-key <key>", "Cursor Admin API key")
  .option("-k, --api-key <key>", "Revenium API key (hak_...)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option("--endpoint <url>", "Revenium API endpoint URL")
  .option("--subscription-tier <tier>", "Cursor subscription tier (pro, business, enterprise, api)")
  .option("--sync-interval <minutes>", "Sync interval in minutes (default: 5)")
  .action(async (options) => {
    let syncInterval: number | undefined = undefined;
    if (options.syncInterval) {
      const minutes = parseFloat(options.syncInterval);
      if (isNaN(minutes) || minutes <= 0) {
        console.error("Error: --sync-interval must be a positive number");
        process.exit(1);
      }
      syncInterval = minutes * 60 * 1000;
    }

    await setupCommand({
      cursorApiKey: options.cursorApiKey,
      reveniumApiKey: options.apiKey,
      email: options.email,
      organizationName: options.organization,
      productName: options.product,
      endpoint: options.endpoint,
      subscriptionTier: options.subscriptionTier,
      syncInterval,
    });
  });

program
  .command("status")
  .description("Check current configuration, sync state, and connectivity")
  .action(async () => {
    await statusCommand();
  });

program
  .command("test")
  .description("Send a test metric to verify the Revenium integration")
  .option("-v, --verbose", "Show detailed payload information")
  .action(async (options) => {
    await testCommand({ verbose: options.verbose });
  });

program
  .command("sync")
  .description("Sync Cursor usage events to Revenium")
  .option("-w, --watch", "Run continuously with configured interval")
  .option("--from <date>", "Start date for sync range (ISO 8601)")
  .option("--to <date>", "End date for sync range (ISO 8601)")
  .action(async (options) => {
    await syncCommand({
      watch: options.watch,
      from: options.from,
      to: options.to,
    });
  });

program
  .command("reset")
  .description("Reset sync state to force a fresh sync")
  .action(async () => {
    await resetCommand();
  });

program
  .command("backfill")
  .description("Import historical Cursor IDE usage data to Revenium")
  .option("--since <date>", "Start date (ISO 8601 or relative: 7d, 1m, 1y)")
  .option("--to <date>", "End date (ISO 8601, defaults to now)")
  .option("--dry-run", "Preview without sending data")
  .option("--batch-size <size>", "Events per OTLP batch (default: 100)")
  .option("-v, --verbose", "Show detailed output")
  .action(async (options) => {
    await backfillCommand({
      since: options.since,
      to: options.to,
      dryRun: options.dryRun,
      batchSize: options.batchSize ? parseInt(options.batchSize, 10) : undefined,
      verbose: options.verbose,
    });
  });

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
