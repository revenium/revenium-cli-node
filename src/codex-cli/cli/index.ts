#!/usr/bin/env node

import { Command } from "commander";
import { setupAction } from "../commands/setup.js";
import { statusAction } from "../commands/status.js";
import { testAction } from "../commands/test.js";
import { backfillAction } from "../commands/backfill.js";
import { runCommand } from "../commands/run.js";
import { installEnvProxyDispatcher } from "../../_core/net/proxy.js";
import pkg from "../../../package.json";

export const program = new Command();

program
  .name("revenium-codex")
  .description("Configure OpenAI Codex CLI telemetry export to Revenium")
  .version(pkg.version)
  .enablePositionalOptions();

program
  .command("setup")
  .description("Interactive setup wizard to configure Codex CLI metering")
  .option("-k, --api-key <key>", "Revenium metering key rev_mk_... (recommended)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option("--endpoint <url>", "Revenium API endpoint URL")
  .option(
    "--config-path <path>",
    "Path to Codex config.toml (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)",
  )
  .option("--force", "Overwrite existing [otel] config without prompting")
  .option("--skip-shell-update", "Skip installing the `codex` wrapper in the shell profile")
  .option(
    "--no-log-tool-details",
    'Write exporter = "none" instead of the OTLP exporter. Codex then exports no live events, ' +
      "so tool arguments and tool output never leave the machine. The API key is stored in " +
      "the Codex home revenium.env ($CODEX_HOME, else ~/.codex) instead of config.toml, and usage " +
      "is imported with `revenium-codex backfill`",
  )
  .action(async (options) => {
    await setupAction({
      apiKey: options.apiKey,
      email: options.email,
      organizationName: options.organization,
      productName: options.product,
      endpoint: options.endpoint,
      configPath: options.configPath,
      force: options.force,
      skipShellUpdate: options.skipShellUpdate,
      logToolDetails: options.logToolDetails === false ? false : undefined,
    });
  });

program
  .command("status")
  .description("Check current Codex otel configuration and endpoint connectivity")
  .option(
    "--config-path <path>",
    "Path to Codex config.toml (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)",
  )
  .action(async (options) => {
    await statusAction({ configPath: options.configPath });
  });

program
  .command("test")
  .description("Send a test metric to verify the Codex integration")
  .option("-v, --verbose", "Show detailed payload information")
  .option(
    "--config-path <path>",
    "Path to Codex config.toml (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)",
  )
  .action(async (options) => {
    await testAction({ verbose: options.verbose, configPath: options.configPath });
  });

program
  .command("backfill")
  .description("Import historical Codex usage sessions into Revenium")
  .option("--since <date>", "Start date (ISO or relative format like 7d, 1m)")
  .option(
    "--to <date>",
    "End date (ISO format, default: now). A date-only value covers the whole day in UTC",
  )
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
  .option(
    "--sessions-path <path>",
    "Path to Codex sessions root (default: $CODEX_HOME/sessions, else ~/.codex/sessions)",
  )
  .option(
    "--config-path <path>",
    "Path to Codex config.toml (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)",
  )
  .option(
    "--project <paths>",
    "Import only these projects, comma-separated (full project path or its folder name)",
  )
  .option(
    "--exclude-project <paths>",
    "Skip these projects, comma-separated (full project path or its folder name)",
  )
  .action(async (options) => {
    await backfillAction({
      since: options.since,
      to: options.to,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      verbose: options.verbose,
      sessionsPath: options.sessionsPath,
      configPath: options.configPath,
      project: options.project,
      excludeProject: options.excludeProject,
    });
  });

program
  .command("run")
  .description("Launch Codex CLI with Revenium attribution injected into its process environment")
  .allowUnknownOption()
  .passThroughOptions()
  .helpOption(false)
  .option(
    "--config-path <path>",
    "Path to Codex config.toml (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)",
  )
  .argument("[args...]", "Arguments forwarded to the codex binary")
  .action(async (args: string[], options: { configPath?: string }) => {
    await runCommand(args, { configPath: options.configPath });
  });

if (process.env.NODE_ENV !== "test") {
  void installEnvProxyDispatcher().then(() => program.parse());
}
