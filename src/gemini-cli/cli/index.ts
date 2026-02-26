#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { testCommand } from "../commands/test.js";
import pkg from "../../../package.json";

export const program = new Command();

program
  .name("revenium-gemini")
  .description("Configure Gemini CLI telemetry export to Revenium")
  .version(pkg.version);

program
  .command("setup")
  .description("Interactive setup wizard to configure Gemini CLI metering")
  .option("-k, --api-key <key>", "Revenium API key (hak_...)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option("-c, --cost-multiplier <number>", "Cost multiplier for pricing adjustments")
  .option("--endpoint <url>", "Revenium API endpoint URL")
  .option("--skip-shell-update", "Skip automatic shell profile update")
  .action(async (options) => {
    let costMultiplier: number | undefined = undefined;
    if (options.costMultiplier) {
      const trimmed = options.costMultiplier.trim();
      costMultiplier = Number(trimmed);
      if (isNaN(costMultiplier) || !isFinite(costMultiplier) || costMultiplier <= 0) {
        console.error("Error: --cost-multiplier must be a valid positive number greater than 0");
        process.exit(1);
      }
    }

    await setupCommand({
      apiKey: options.apiKey,
      email: options.email,
      organizationName: options.organization,
      productName: options.product,
      costMultiplier,
      endpoint: options.endpoint,
      skipShellUpdate: options.skipShellUpdate,
    });
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

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
