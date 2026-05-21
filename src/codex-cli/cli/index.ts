#!/usr/bin/env node

import { Command } from "commander";
import { setupAction } from "../commands/setup.js";
import { statusAction } from "../commands/status.js";
import { testAction } from "../commands/test.js";
import { backfillAction } from "../commands/backfill.js";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import pkg from "../../../package.json";

export const program = new Command();

program
  .name("revenium-codex")
  .description("Configure OpenAI Codex CLI telemetry export to Revenium")
  .version(pkg.version);

program
  .command("setup")
  .description("Interactive setup wizard to configure Codex CLI metering")
  .option("-k, --api-key <hak>", "Revenium API key (hak_... or rev_...)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option("--endpoint <url>", "Revenium API endpoint URL", DEFAULT_REVENIUM_URL)
  .option("--config-path <path>", "Path to Codex config.toml (default: ~/.codex/config.toml)")
  .option("--skip-shell-update", "Skip automatic shell profile update")
  .option("--force", "Overwrite existing [otel] config without prompting")
  .action(async (options) => {
    await setupAction({
      apiKey: options.apiKey,
      email: options.email,
      organizationName: options.organization,
      productName: options.product,
      endpoint: options.endpoint,
      configPath: options.configPath,
      skipShellUpdate: options.skipShellUpdate,
      force: options.force,
    });
  });

program
  .command("status")
  .description("Check current Codex otel configuration and endpoint connectivity")
  .option("--config-path <path>", "Path to Codex config.toml (default: ~/.codex/config.toml)")
  .action(async (options) => {
    await statusAction({ configPath: options.configPath });
  });

program
  .command("test")
  .description("Send a test metric to verify the Codex integration")
  .option("-v, --verbose", "Show detailed payload information")
  .option("--config-path <path>", "Path to Codex config.toml (default: ~/.codex/config.toml)")
  .action(async (options) => {
    await testAction({ verbose: options.verbose, configPath: options.configPath });
  });

program
  .command("backfill")
  .description("Import historical Codex usage sessions into Revenium")
  .option("--since <date>", "Start date (ISO or relative format like 7d, 1m)")
  .option("--to <date>", "End date (ISO format, default: now)")
  .option("--dry-run", "Show what would be sent without sending")
  .option("--batch-size <N>", "Records per batch", (value) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`--batch-size must be a positive integer, got: ${value}`);
      process.exit(1);
    }
    return n;
  })
  .option("--verbose", "Show detailed processing output")
  .option("--sessions-path <path>", "Path to Codex sessions root (default: ~/.codex/sessions)")
  .option("--config-path <path>", "Path to Codex config.toml (default: ~/.codex/config.toml)")
  .action(async (options) => {
    await backfillAction({
      since: options.since,
      to: options.to,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      verbose: options.verbose,
      sessionsPath: options.sessionsPath,
      configPath: options.configPath,
    });
  });

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
