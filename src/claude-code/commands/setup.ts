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
import { SUBSCRIPTION_TIER_CONFIG, type SubscriptionTier } from "../constants.js";
import type { ClaudeCodeConfig } from "../config/loader.js";
import type { ShellType } from "../../_core/types/index.js";

interface SetupOptions {
  apiKey?: string;
  email?: string;
  tier?: string;
  endpoint?: string;
  organizationId?: string;
  productId?: string;
  skipShellUpdate?: boolean;
}

function getSourceCommand(shellType: ShellType, configPath: string): string {
  switch (shellType) {
    case "fish":
      return `if test -f "${configPath}"\n    export (cat "${configPath}" | grep -v '^#' | xargs -L 1)\nend`;
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
    const configPath = await writeConfig(config);
    writeSpinner.succeed(`Configuration written to ${chalk.cyan(configPath)}`);
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

  printSuccessMessage(config);
}

async function collectConfiguration(options: SetupOptions): Promise<ClaudeCodeConfig> {
  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: "Enter your Revenium API key:",
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
      type: "list",
      name: "tier",
      message: "Select your Claude Code subscription tier:",
      when: !options.tier,
      pageSize: 20,
      choices: [
        ...Object.entries(SUBSCRIPTION_TIER_CONFIG).map(([key, cfg]) => ({
          name: cfg.name,
          value: key,
        })),
        new inquirer.Separator(" "),
      ],
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
  } catch {
    // use as-is
  }

  endpoint = endpoint.replace(/\/+$/, "");

  return {
    apiKey: options.apiKey || answers.apiKey,
    email: options.email || answers.email || undefined,
    subscriptionTier: (options.tier || answers.tier) as SubscriptionTier,
    endpoint,
    organizationId: options.organizationId,
    productId: options.productId,
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
  if (config.subscriptionTier) {
    const tier = config.subscriptionTier as SubscriptionTier;
    const tierConfig = SUBSCRIPTION_TIER_CONFIG[tier];
    console.log(`  Tier:       ${tierConfig.name}`);
  }

  console.log("\n" + chalk.yellow.bold("Next steps:"));
  console.log("  1. Restart your terminal or run:");
  console.log(chalk.cyan("     source ~/.claude/revenium.env"));
  console.log("  2. Start using Claude Code - telemetry will be sent automatically");
  console.log("  3. Import past usage by running: " + chalk.cyan("revenium-metering backfill"));
  console.log("  4. Check your usage at https://app.revenium.ai");
}
