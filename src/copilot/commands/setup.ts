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
import { testConnectivity } from "../core/github-client.js";
import {
  DEFAULT_SYNC_INTERVAL_MS,
  SERVICE_NAME,
  SUBSCRIPTION_TIER_CONFIG,
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
} from "../constants.js";
import type { CopilotConfig } from "../types.js";
import type { ShellType } from "../../_core/types/index.js";

interface SetupOptions {
  githubToken?: string;
  githubOrg?: string;
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

function validateGithubToken(token: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!token || token.trim() === "") {
    errors.push("GitHub token is required");
    return { valid: false, errors };
  }

  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    errors.push("GitHub token should start with ghp_ or github_pat_");
  }

  if (token.length < 10) {
    errors.push("GitHub token appears too short");
  }

  return { valid: errors.length === 0, errors };
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Metering Setup\n"));
  console.log(chalk.dim("This wizard will configure GitHub Copilot usage sync to Revenium.\n"));

  const config = await collectConfiguration(options);

  const githubSpinner = ora("Testing GitHub Copilot API connectivity...").start();

  try {
    const githubOk = await testConnectivity(config.githubToken, config.githubOrg);

    if (!githubOk) {
      githubSpinner.fail("GitHub Copilot API connectivity failed");
      console.log(chalk.yellow("\nPlease check your GitHub token and organization name."));
      console.log(chalk.dim("Token needs manage_billing:copilot or read:org scope."));
      process.exit(1);
    }

    githubSpinner.succeed("GitHub Copilot API connected");
  } catch (error) {
    githubSpinner.fail("Failed to connect to GitHub Copilot API");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

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
  const nonInteractive = !!(
    options.githubToken &&
    options.githubOrg &&
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
          name: "githubToken",
          message: "Enter your GitHub personal access token:",
          when: !options.githubToken,
          validate: (input: string) => {
            const result = validateGithubToken(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "input",
          name: "githubOrg",
          message: "Enter your GitHub organization slug:",
          when: !options.githubOrg,
          validate: (input: string) => {
            if (!input || input.trim() === "") return "Organization slug is required";
            if (!/^[a-zA-Z0-9_-]+$/.test(input)) return "Invalid organization slug format";
            return true;
          },
        },
        {
          type: "password",
          name: "reveniumApiKey",
          message: "Enter your Revenium API key (hak_... or rev_...):",
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
          message: "GitHub Copilot subscription tier:",
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

  const rawTier = options.subscriptionTier || answers.subscriptionTier;
  const subscriptionTier =
    rawTier && SUBSCRIPTION_TIERS.includes(rawTier as SubscriptionTier)
      ? (rawTier as SubscriptionTier)
      : undefined;

  return {
    githubToken: options.githubToken || answers.githubToken,
    githubOrg: options.githubOrg || answers.githubOrg,
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

function printSuccessMessage(config: CopilotConfig): void {
  console.log("\n" + chalk.green.bold("Setup complete!") + "\n");

  console.log(chalk.bold("Configuration:"));
  console.log(`  GitHub Token:     ${maskApiKey(config.githubToken)}`);
  console.log(`  GitHub Org:       ${config.githubOrg}`);
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
  console.log("  1. Run `revenium-copilot sync` to trigger an immediate sync");
  console.log("  2. Run `revenium-copilot sync --watch` for continuous syncing");
  console.log("  3. Run `revenium-copilot backfill --since 28d` to import historical data");
  console.log("  4. Check your usage at https://app.revenium.ai");

  console.log(
    "\n" + chalk.dim("Run `revenium-copilot status` to verify the configuration at any time."),
  );
}
