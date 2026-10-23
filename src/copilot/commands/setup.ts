import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  validateOrganizationName,
  validateProductName,
} from "../../_core/config/validator.js";
import { enforceSetupFlags, enforceSetupInputs } from "../../_core/config/setup-input-gate.js";
import { firstNonEmpty } from "../../_core/utils/optional-text.js";
import { extractBaseEndpoint } from "../../_core/config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { updateShellProfile, getManualInstructions } from "../../_core/shell/profile-updater.js";
import { detectShell, validateConfigPath } from "../../_core/shell/detector.js";
import { writeConfig } from "../config/writer.js";
import { getConfigPath, findUnknownConfigKeys } from "../config/loader.js";
import { printUnknownConfigKeys } from "../../_core/ui/unknown-config-keys.js";
import { isInteractive, requireOptions } from "../../_core/ui/interactive.js";
import { parseSubscriptionTier } from "../../_core/config/subscription-tier.js";
import {
  DEFAULT_SYNC_INTERVAL_MS,
  SERVICE_NAME,
  SUBSCRIPTION_TIER_CONFIG,
  SUBSCRIPTION_TIERS,
} from "../constants.js";
import type { CopilotConfig } from "../types.js";
import type { ShellType } from "../../_core/types/index.js";

interface SetupOptions {
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
    case "fish": {
      const fishConfigPath = configPath.replace(/\.env$/, ".fish");
      return `if test -f "${fishConfigPath}"\n    source "${fishConfigPath}"\nend`;
    }
    default:
      return `if [ -f "${configPath}" ]; then\n    source "${configPath}"\nfi`;
  }
}

function getConfigFilePath(): string {
  return getConfigPath();
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Metering Setup\n"));
  console.log(chalk.dim("This wizard configures the Revenium credentials the CLI needs.\n"));

  printUnknownConfigKeys(getConfigPath(), await findUnknownConfigKeys());

  const config = await collectConfiguration(options);

  const reveniumSpinner = ora("Testing Revenium API key...").start();

  try {
    const healthResult = await checkEndpointHealth(
      config.reveniumEndpoint,
      config.reveniumApiKey,
      SERVICE_NAME,
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
    const { envPath, fishPath } = await writeConfig(config);
    writeSpinner.succeed(
      `Configuration written to ${chalk.cyan(envPath)} and ${chalk.cyan(fishPath)}`,
    );
  } catch (error) {
    writeSpinner.fail("Failed to write configuration");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const shellSpinner = ora("Updating shell profile...").start();

  try {
    const shellResult = await updateShellProfile({
      markerName: "revenium-copilot-metering",
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
                markerName: "revenium-copilot-metering",
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

async function collectConfiguration(options: SetupOptions): Promise<CopilotConfig> {
  const interactive = isInteractive();

  if (!interactive) {
    requireOptions([
      { flag: "--api-key", value: options.reveniumApiKey },
      {
        flag: "--subscription-tier",
        value: options.subscriptionTier,
        allowedValues: SUBSCRIPTION_TIERS,
      },
    ]);
  }

  enforceSetupFlags({
    apiKey: options.reveniumApiKey,
    email: options.email,
    endpoint: options.endpoint,
    organizationName: options.organizationName,
    productName: options.productName,
  });

  const allRequiredProvided = [
    options.reveniumApiKey,
    options.endpoint,
    options.subscriptionTier,
  ].every((value) => value !== undefined);

  const skipPrompts = !interactive || allRequiredProvided;

  const tierChoices = SUBSCRIPTION_TIERS.map((tier) => ({
    name: SUBSCRIPTION_TIER_CONFIG[tier].name,
    value: tier,
  }));

  const answers: Record<string, string> = skipPrompts
    ? {}
    : await inquirer.prompt([
        {
          type: "password",
          name: "reveniumApiKey",
          message: "Enter your Revenium metering key rev_mk_... (recommended):",
          when: options.reveniumApiKey === undefined,
          validate: (input: string) => {
            const result = validateApiKey(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "list",
          name: "subscriptionTier",
          message: "GitHub Copilot subscription tier:",
          choices: tierChoices,
          when: options.subscriptionTier === undefined,
        },
        {
          type: "input",
          name: "email",
          message: "Admin contact email (optional, not used for attribution):",
          when: options.email === undefined,
          validate: (input: string) => {
            if (!input) return true;
            const result = validateEmail(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "organizationName",
          message: "Organization name (for cost attribution, optional):",
          when: options.organizationName === undefined,
          validate: (input: string) => {
            const result = validateOrganizationName(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "productName",
          message: "Product name (for cost attribution, optional):",
          when: options.productName === undefined,
          validate: (input: string) => {
            const result = validateProductName(input.trim());
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
      ]);

  const rawEndpoint = options.endpoint || answers.endpoint || DEFAULT_REVENIUM_URL;
  const endpoint = extractBaseEndpoint(rawEndpoint);

  const syncIntervalMs =
    options.syncInterval !== undefined ? options.syncInterval : DEFAULT_SYNC_INTERVAL_MS;

  const subscriptionTier = parseSubscriptionTier(
    options.subscriptionTier || answers.subscriptionTier,
    SUBSCRIPTION_TIERS,
  );

  const reveniumApiKey = options.reveniumApiKey ?? answers.reveniumApiKey;
  const email = firstNonEmpty(options.email, answers.email);
  const organizationName = firstNonEmpty(options.organizationName, answers.organizationName);
  const productName = firstNonEmpty(options.productName, answers.productName);

  enforceSetupInputs({
    apiKey: reveniumApiKey,
    email,
    endpoint: rawEndpoint,
    organizationName,
    productName,
  });

  return {
    reveniumApiKey,
    reveniumEndpoint: endpoint,
    email,
    organizationName,
    productName,
    syncIntervalMs,
    subscriptionTier,
  };
}

function printSuccessMessage(config: CopilotConfig): void {
  console.log("\n" + chalk.green.bold("Setup complete!") + "\n");

  console.log(chalk.bold("Configuration:"));
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
  console.log(
    "  1. Register your GitHub credential under Connections > Providers > GitHub Copilot in the Revenium dashboard",
  );
  console.log("  2. Revenium then refreshes Copilot usage once daily — nothing to keep running");
  console.log(
    "  3. To import history, run `revenium-copilot backfill --since 28d` with --github-token and --github-org",
  );
  console.log("  4. Check your usage at https://app.revenium.ai");

  console.log(
    "\n" +
      chalk.dim(
        "This wizard never stores your GitHub token. Run `revenium-copilot status` to verify the configuration at any time.",
      ),
  );
}
