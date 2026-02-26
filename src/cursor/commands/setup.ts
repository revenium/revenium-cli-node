import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { validateApiKey, validateEmail } from "../../_core/config/validator.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { updateShellProfile, getManualInstructions } from "../../_core/shell/profile-updater.js";
import { detectShell, validateConfigPath } from "../../_core/shell/detector.js";
import { writeConfig } from "../config/writer.js";
import { getConfigPath } from "../config/loader.js";
import { testConnectivity } from "../core/cursor-client.js";
import {
  DEFAULT_SYNC_INTERVAL_MS,
  SUBSCRIPTION_TIER_CONFIG,
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
} from "../constants.js";
import type { CursorConfig } from "../types.js";
import type { ShellType } from "../../_core/types/index.js";

interface SetupOptions {
  cursorApiKey?: string;
  reveniumApiKey?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  syncInterval?: number;
  endpoint?: string;
  subscriptionTier?: string;
}

function getSourceCommand(shellType: ShellType, configPath: string): string {
  validateConfigPath(configPath);

  switch (shellType) {
    case "fish":
      return `if test -f "${configPath}"\n    export (cat "${configPath}" | grep -v '^#' | xargs -L 1)\nend`;
    default:
      return `if [ -f "${configPath}" ]; then\n    source "${configPath}"\nfi`;
  }
}

function getConfigFilePath(): string {
  return getConfigPath();
}

function validateCursorApiKey(apiKey: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!apiKey || apiKey.trim() === "") {
    errors.push("Cursor API key is required");
    return { valid: false, errors };
  }

  if (apiKey.length < 8) {
    errors.push("Cursor API key appears too short");
  }

  return { valid: errors.length === 0, errors };
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Cursor IDE Metering Setup\n"));
  console.log(chalk.dim("This wizard will configure Cursor IDE usage sync to Revenium.\n"));

  const config = await collectConfiguration(options);

  const cursorSpinner = ora("Testing Cursor API connectivity...").start();

  try {
    const cursorOk = await testConnectivity(config.cursorApiKey);

    if (!cursorOk) {
      cursorSpinner.fail("Cursor API connectivity failed");
      console.log(chalk.yellow("\nPlease check your Cursor API key and try again."));
      process.exit(1);
    }

    cursorSpinner.succeed("Cursor API connected");
  } catch (error) {
    cursorSpinner.fail("Failed to connect to Cursor API");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const reveniumSpinner = ora("Testing Revenium API key...").start();

  try {
    const healthResult = await checkEndpointHealth(
      config.reveniumEndpoint,
      config.reveniumApiKey,
      "cursor-ide",
      {
        email: config.email,
        organizationName: config.organizationName,
        productName: config.productName,
      },
    );

    if (!healthResult.healthy) {
      reveniumSpinner.fail(`Revenium API validation failed: ${healthResult.message}`);
      console.log(chalk.yellow("\nPlease check your Revenium API key and try again."));
      process.exit(1);
    }

    reveniumSpinner.succeed(`Revenium API validated (${healthResult.latencyMs}ms latency)`);
  } catch (error) {
    reveniumSpinner.fail("Failed to validate Revenium API key");
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

  const shellSpinner = ora("Updating shell profile...").start();

  try {
    const shellResult = await updateShellProfile({
      markerName: "revenium-cursor-metering",
      getSourceCommand,
      getConfigFilePath,
    });

    if (shellResult.success) {
      shellSpinner.succeed(shellResult.message);
    } else {
      shellSpinner.warn(shellResult.message);
      const shellType = detectShell();
      if (shellType !== "unknown") {
        console.log(
          chalk.dim(
            "\n" +
              getManualInstructions({
                markerName: "revenium-cursor-metering",
                getSourceCommand,
                getConfigFilePath,
              }),
          ),
        );
      }
    }
  } catch {
    shellSpinner.warn("Could not update shell profile automatically");
  }

  printSuccessMessage(config);
}

async function collectConfiguration(options: SetupOptions): Promise<CursorConfig> {
  const nonInteractive = !!(
    options.cursorApiKey &&
    options.reveniumApiKey &&
    options.endpoint &&
    options.subscriptionTier
  );

  const tierChoices = SUBSCRIPTION_TIERS.map((tier) => ({
    name: SUBSCRIPTION_TIER_CONFIG[tier].name,
    value: tier,
  }));

  const answers: Record<string, string> = nonInteractive
    ? {}
    : await inquirer.prompt([
        {
          type: "password",
          name: "cursorApiKey",
          message: "Enter your Cursor Admin API key:",
          when: !options.cursorApiKey,
          validate: (input: string) => {
            const result = validateCursorApiKey(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "password",
          name: "reveniumApiKey",
          message: "Enter your Revenium API key (hak_...):",
          when: !options.reveniumApiKey,
          validate: (input: string) => {
            const result = validateApiKey(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "list",
          name: "subscriptionTier",
          message: "Cursor subscription tier:",
          choices: tierChoices,
          when: !options.subscriptionTier,
        },
        {
          type: "input",
          name: "email",
          message: "Admin email (for attribution, optional):",
          when: !options.email,
          validate: (input: string) => {
            if (!input) return true;
            const result = validateEmail(input);
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "organizationName",
          message: "Organization name (for cost attribution, optional):",
          when: !options.organizationName,
          validate: (input: string) => {
            if (!input) return true;
            if (input.trim().length > 255) {
              return "Organization name is too long (max 255 characters)";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "productName",
          message: "Product name (for cost attribution, optional):",
          when: !options.productName,
          validate: (input: string) => {
            if (!input) return true;
            if (input.trim().length > 255) {
              return "Product name is too long (max 255 characters)";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "endpoint",
          message: "Revenium API endpoint:",
          default: DEFAULT_REVENIUM_URL,
          when: !options.endpoint,
          validate: (input: string) => {
            try {
              new URL(input);
              return true;
            } catch {
              return "Please enter a valid URL";
            }
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

  const syncIntervalMs =
    options.syncInterval !== undefined ? options.syncInterval : DEFAULT_SYNC_INTERVAL_MS;

  const subscriptionTier = (options.subscriptionTier || answers.subscriptionTier) as
    | SubscriptionTier
    | undefined;

  return {
    cursorApiKey: options.cursorApiKey || answers.cursorApiKey,
    reveniumApiKey: options.reveniumApiKey || answers.reveniumApiKey,
    reveniumEndpoint: endpoint,
    email: options.email || answers.email?.trim() || undefined,
    organizationName:
      options.organizationName?.trim() || answers.organizationName?.trim() || undefined,
    productName: options.productName?.trim() || answers.productName?.trim() || undefined,
    syncIntervalMs,
    subscriptionTier,
  };
}

function printSuccessMessage(config: CursorConfig): void {
  console.log("\n" + chalk.green.bold("Setup complete!") + "\n");

  console.log(chalk.bold("Configuration:"));
  console.log(`  Cursor API Key:   ${maskApiKey(config.cursorApiKey)}`);
  console.log(`  Revenium API Key: ${maskApiKey(config.reveniumApiKey)}`);
  console.log(`  Endpoint:         ${config.reveniumEndpoint}`);
  if (config.subscriptionTier) {
    console.log(`  Subscription:     ${SUBSCRIPTION_TIER_CONFIG[config.subscriptionTier].name}`);
  }
  if (config.email) {
    console.log(`  Email:            ${maskEmail(config.email)}`);
  }
  if (config.organizationName) {
    console.log(`  Organization:     ${config.organizationName}`);
  }
  if (config.productName) {
    console.log(`  Product:          ${config.productName}`);
  }
  console.log(`  Sync Interval:    ${config.syncIntervalMs / 1000 / 60} minutes`);

  console.log("\n" + chalk.yellow.bold("Next steps:"));
  console.log("  1. Run `revenium-cursor sync` to trigger an immediate sync");
  console.log("  2. Run `revenium-cursor sync --watch` for continuous syncing");
  console.log("  3. Run `revenium-cursor backfill --since 30d` to import historical data");
  console.log("  4. Check your usage at https://app.revenium.ai");

  console.log(
    "\n" + chalk.dim("Run `revenium-cursor status` to verify the configuration at any time."),
  );
}
