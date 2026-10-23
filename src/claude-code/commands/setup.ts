import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
} from "../../_core/config/validator.js";
import { enforceSetupFlags, enforceSetupInputs } from "../../_core/config/setup-input-gate.js";
import { firstNonEmpty } from "../../_core/utils/optional-text.js";
import { abortSetup } from "../../_core/ui/abort-setup.js";
import { isInteractive, requireOptions } from "../../_core/ui/interactive.js";
import { extractBaseEndpoint } from "../../_core/config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { removeShellProfileConfig } from "../../_core/shell/profile-updater.js";
import { writeConfig } from "../config/writer.js";
import { removeLegacyTicketGate } from "../config/legacy-ticket-gate.js";
import { applyTelemetryEnv } from "../config/claude-settings.js";
import type { ClaudeCodeConfig } from "../config/loader.js";

export interface SetupOptions {
  apiKey?: string;
  email?: string;
  endpoint?: string;
  organizationName?: string;
  productName?: string;
  extraUsageEnabled?: boolean;

  logToolDetails?: boolean;

  blockPolicy?: string;

  teamId?: string;

  managementEndpoint?: string;
}

async function clearLegacyShellExport(): Promise<void> {
  const clearedProfiles = await removeShellProfileConfig("revenium-claude-code-metering");
  if (clearedProfiles.length > 0) {
    console.log(
      chalk.dim(`Removed the superseded Revenium block from ${clearedProfiles.join(" and ")}.`),
    );
  }
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Claude Code Metering Setup\n"));

  const config = await collectConfiguration(options);

  const spinner = ora("Testing API key...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "claude-code");

    if (!healthResult.healthy) {
      spinner.fail(`API key validation failed: ${healthResult.message}`);
      abortSetup();
    }

    spinner.succeed(`API key validated (${healthResult.latencyMs}ms latency)`);
  } catch (error) {
    spinner.fail("Failed to validate API key");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    abortSetup();
  }

  const writeSpinner = ora("Writing configuration...").start();

  try {
    const envPath = await writeConfig(config);
    writeSpinner.succeed(`Configuration written to ${chalk.cyan(envPath)}`);
  } catch (error) {
    writeSpinner.fail("Failed to write configuration");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const settingsSpinner = ora("Applying telemetry settings...").start();
  const telemetry = await applyTelemetryEnv(config);

  if (!telemetry.applied) {
    settingsSpinner.fail(`Could not update ${telemetry.path}: ${telemetry.error}`);
    console.log(chalk.dim("  Fix that file, then re-run setup to enable telemetry."));
    process.exit(1);
  }

  settingsSpinner.succeed(`Telemetry enabled for Claude Code in ${chalk.cyan(telemetry.path)}`);

  await clearLegacyShellExport();

  // An older release of this CLI installed its own ticket gate hook. The supported gate is now the
  // bash gate in the `revenium` Claude Code plugin, and leaving both registered gives a developer
  // two notices per prompt and two workers racing the same session lock. Every setup run clears
  // the old registration; the plugin's own health check tells developers to re-run setup for
  // exactly this reason.
  // A stranded registration leaves nothing removed, so `removed` is false precisely in the case
  // this warning exists for; gating on `removed` would print nothing when a developer's settings
  // file most needs their attention.
  const cleanup = await removeLegacyTicketGate();
  if (cleanup.hookRemovedFromSettings || cleanup.scriptDeleted) {
    console.log(chalk.dim("Removed legacy Revenium ticket gate hook from Claude Code settings."));
  }

  printSuccessMessage(config);
}

async function collectConfiguration(options: SetupOptions): Promise<ClaudeCodeConfig> {
  const interactive = isInteractive();

  if (!interactive) {
    requireOptions([{ flag: "--api-key", value: options.apiKey }]);
  }

  enforceSetupFlags({
    apiKey: options.apiKey,
    email: options.email,
    endpoint: options.endpoint,
    managementEndpoint: options.managementEndpoint,
    organizationName: options.organizationName,
    productName: options.productName,
  });

  const answers: Record<string, string> = interactive
    ? await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: "Enter your Revenium metering key rev_mk_... (recommended):",
          when: options.apiKey === undefined,
          validate: (input: string) => {
            const result = validateApiKey(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "input",
          name: "email",
          message: "Enter your email (for usage attribution):",
          when: options.email === undefined,
          validate: (input: string) => {
            if (!input) return true;
            const result = validateEmail(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "endpoint",
          message: "Revenium API endpoint:",
          default: DEFAULT_REVENIUM_URL,
          when: options.endpoint === undefined,
          validate: (input: string) => {
            const result = validateEndpointUrl(input);
            return result.valid || result.errors.join(", ");
          },
        },
      ])
    : {};

  const rawEndpoint = options.endpoint || answers.endpoint || DEFAULT_REVENIUM_URL;
  const endpoint = extractBaseEndpoint(rawEndpoint);
  const apiKey = options.apiKey ?? answers.apiKey;
  const email = firstNonEmpty(options.email, answers.email);
  const organizationName = firstNonEmpty(options.organizationName);
  const productName = firstNonEmpty(options.productName);

  enforceSetupInputs({
    apiKey,
    email,
    endpoint: rawEndpoint,
    managementEndpoint: options.managementEndpoint,
    organizationName,
    productName,
  });

  return {
    apiKey,
    email,
    endpoint,
    organizationName,
    productName,
    extraUsageEnabled: options.extraUsageEnabled,
    logToolDetails: options.logToolDetails,
    teamId: options.teamId,
    managementEndpoint: options.managementEndpoint,
  };
}

function printSuccessMessage(config: ClaudeCodeConfig): void {
  console.log("\n" + chalk.green.bold("Setup complete!") + "\n");

  console.log(chalk.bold("Configuration:"));
  console.log(`  API Key:    ${maskApiKey(config.apiKey)}`);
  console.log(`  Endpoint:   ${config.endpoint}`);
  if (config.email) {
    console.log(`  Email:      ${maskEmail(config.email)}`);
  }
  console.log("\n" + chalk.yellow.bold("Next steps:"));
  console.log("  1. Start a new Claude Code session to pick up the telemetry settings.");
  console.log("  2. Import past usage by running: " + chalk.cyan("revenium-metering backfill"));
  console.log("  3. Check your usage at https://app.revenium.ai");
}
