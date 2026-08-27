#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand, type SetupOptions } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { testCommand } from "../commands/test.js";
import { backfillCommand } from "../commands/backfill.js";
import pkg from "../../../package.json";

export const program = new Command();

interface CliSetupOptions {
  apiKey?: string;
  email?: string;
  endpoint?: string;
  organization?: string;
  product?: string;
  teamId?: string;
  skipShellUpdate?: boolean;
  extraUsageEnabled?: boolean;
  mgmtEndpoint?: string;
}

export function toSetupOptions(options: CliSetupOptions): SetupOptions {
  return {
    apiKey: options.apiKey,
    email: options.email,
    endpoint: options.endpoint,
    organizationName: options.organization,
    productName: options.product,
    teamId: options.teamId,
    skipShellUpdate: options.skipShellUpdate,
    extraUsageEnabled: options.extraUsageEnabled || undefined,
    managementEndpoint: options.mgmtEndpoint,
  };
}

program
  .name("revenium-metering")
  .description("Configure Claude Code telemetry export to Revenium")
  .version(pkg.version);

program
  .command("setup")
  .description("Interactive setup wizard to configure Claude Code metering")
  .option("-k, --api-key <key>", "Revenium API key (hak_... or rev_...)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("--endpoint <url>", "Revenium API endpoint URL")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option(
    "--team-id <id>",
    "Organization hashid for session attribution (optional when the backend derives it from the metering key)",
  )
  .option(
    "--mgmt-endpoint <url>",
    "Override the management-plane API base URL used for session attribution " +
      "(defaults to <endpoint>/profitstream — set this if your environment's context path differs)",
  )
  .option("--skip-shell-update", "Skip automatic shell profile update")
  .option("--extra-usage-enabled", "Set CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 in SDK config")
  .action(async (options: CliSetupOptions) => {
    await setupCommand(toSetupOptions(options));
  });

program
  .command("status")
  .description("Check current configuration and endpoint connectivity")
  .action(async () => {
    await statusCommand();
  });

program
  .command("test")
  .description("Send a test metric to verify the integration")
  .option("-v, --verbose", "Show detailed payload information")
  .action(async (options) => {
    await testCommand({ verbose: options.verbose });
  });

program
  .command("backfill")
  .description("Import historical Claude Code usage data from local JSONL files")
  .option(
    "--since <date>",
    'Only backfill after this date (ISO format or relative like "7d", "1m")',
  )
  .option("--dry-run", "Show what would be sent without sending")
  .option("--batch-size <n>", "Messages per API batch, max 100 (default: 10)", "10")
  .option("--delay <ms>", "Minimum delay between batches in milliseconds (default: 0)", "0")
  .option("-v, --verbose", "Show detailed progress")
  .option(
    "--email <email>",
    "Email to attribute backfilled usage to (overrides the configured email; prompted if neither is set)",
  )
  .action(async (options) => {
    const batchSize = parseInt(options.batchSize, 10);
    if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 100) {
      console.error("Error: --batch-size must be between 1 and 100");
      process.exit(1);
    }

    const delay = parseInt(options.delay, 10);
    if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
      console.error("Error: --delay must be between 0 and 60000 milliseconds");
      process.exit(1);
    }

    await backfillCommand({
      since: options.since,
      dryRun: options.dryRun,
      batchSize,
      delay,
      verbose: options.verbose,
      email: options.email,
    });
  });

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
