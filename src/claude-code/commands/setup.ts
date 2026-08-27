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
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { updateShellProfile, getManualInstructions } from "../../_core/shell/profile-updater.js";
import { writeConfig, getConfigFilePath } from "../config/writer.js";
import type { ClaudeCodeConfig } from "../config/loader.js";
import { removeLegacyTicketGate } from "../config/legacy-ticket-gate.js";
import type { ShellType } from "../../_core/types/index.js";

export interface SetupOptions {
  apiKey?: string;
  email?: string;
  endpoint?: string;
  organizationName?: string;
  productName?: string;
  skipShellUpdate?: boolean;
  extraUsageEnabled?: boolean;

  teamId?: string;

  managementEndpoint?: string;
}

function getSourceCommand(shellType: ShellType, configPath: string): string {
  switch (shellType) {
    case "fish": {
      const fishConfigPath = configPath.replace(/\.env$/, ".fish");
      return `if test -f "${fishConfigPath}"\n    source "${fishConfigPath}"\nend`;
    }
    default:
      return `if [ -f "${configPath}" ]; then\n    source "${configPath}"\nfi`;
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
      process.exit(1);
    }

    spinner.succeed(`API key validated (${healthResult.latencyMs}ms latency)`);
  } catch (error) {
    spinner.fail("Failed to validate API key");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const writeSpinner = ora("Writing configuration...").start();

  try {
    const { envPath, fishPath } = await writeConfig(config);
    writeSpinner.succeed(
      `Configuration written to ${chalk.cyan(envPath)} and ${chalk.cyan(fishPath)}`,
    );
  } catch (error) {
    writeSpinner.fail("Failed to write configuration");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  if (!options.skipShellUpdate) {
    const shellSpinner = ora("Updating shell profile...").start();

    try {
      const shellResult = await updateShellProfile({
        markerName: "revenium-claude-code-metering",
        getSourceCommand,
        getConfigFilePath,
      });

      if (shellResult.success) {
        shellSpinner.succeed(shellResult.message);
      } else {
        shellSpinner.warn(shellResult.message);
        console.log(
          chalk.dim(
            `\nManual setup:\n${getManualInstructions({
              markerName: "revenium-claude-code-metering",
              getSourceCommand,
              getConfigFilePath,
            })}`,
          ),
        );
      }
    } catch {
      shellSpinner.warn("Could not update shell profile automatically");
    }
  }

  const cleanup = await removeLegacyTicketGate();
  if (cleanup.hookRemovedFromSettings || cleanup.scriptDeleted) {
    console.log(chalk.dim("Removed legacy Revenium ticket gate hook from Claude Code settings."));
  }

  printSuccessMessage(config);
}

async function collectConfiguration(options: SetupOptions): Promise<ClaudeCodeConfig> {
  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: "Enter your Revenium API key (hak_... or rev_...):",
      when: !options.apiKey,
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
      when: !options.email,
      validate: (input: string) => {
        if (!input) return true;
        const result = validateEmail(input);
        return result.valid || result.errors.join(", ");
      },
    },
    {
      type: "input",
      name: "endpoint",
      message: "Revenium API endpoint:",
      default: DEFAULT_REVENIUM_URL,
      when: !options.endpoint,
      validate: (input: string) => {
        const result = validateEndpointUrl(input);
        return result.valid || result.errors[0] || "Invalid endpoint URL";
      },
    },
  ]);

  const rawEndpoint = options.endpoint || answers.endpoint || DEFAULT_REVENIUM_URL;
  let endpoint = rawEndpoint.replace(/\/+$/, "");

  try {
    const url = new URL(endpoint);
    if (url.pathname.includes("/meter")) {
      url.pathname = url.pathname.split("/meter")[0];
      endpoint = url.origin + url.pathname;
    }
  } catch {}

  endpoint = endpoint.replace(/\/+$/, "");

  return {
    apiKey: options.apiKey || answers.apiKey,
    email: options.email || answers.email || undefined,
    endpoint,
    organizationName: options.organizationName,
    productName: options.productName,
    extraUsageEnabled: options.extraUsageEnabled,
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
  const isFish = process.env.SHELL?.includes("fish");
  const sourceFile = isFish ? "~/.claude/revenium.fish" : "~/.claude/revenium.env";

  console.log("\n" + chalk.yellow.bold("Next steps:"));
  console.log("  1. Restart your terminal or run:");
  console.log(chalk.cyan(`     source ${sourceFile}`));
  console.log("  2. Import past usage by running: " + chalk.cyan("revenium-metering backfill"));
  console.log("  3. Check your usage at https://app.revenium.ai");
}
