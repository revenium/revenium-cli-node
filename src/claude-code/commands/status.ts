import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists, isEnvLoaded, getConfigPath } from "../config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { detectShell, getProfilePath } from "../../_core/shell/detector.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold("\nRevenium Claude Code Metering Status\n"));

  const configPath = getConfigPath();
  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.dim(`Expected at: ${configPath}`));
    console.log(chalk.yellow("\nRun `revenium-metering setup` to configure Claude Code metering."));
    process.exit(1);
  }

  console.log(chalk.green("Configuration file found"));
  console.log(chalk.dim(`  ${configPath}`));

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("\nCould not parse configuration file"));
    console.log(chalk.yellow("Run `revenium-metering setup` to reconfigure."));
    process.exit(1);
  }

  console.log("\n" + chalk.bold("Configuration:"));
  console.log(`  API Key:    ${maskApiKey(config.apiKey)}`);
  console.log(`  Endpoint:   ${config.endpoint}`);
  if (config.email) {
    console.log(`  Email:      ${maskEmail(config.email)}`);
  }
  if (config.subscriptionTier) {
    console.log(`  Tier:       ${config.subscriptionTier}`);
  }
  const organizationValue = config.organizationName || config.organizationId;
  if (organizationValue) {
    console.log(`  Organization: ${organizationValue}`);
  }
  const productValue = config.productName || config.productId;
  if (productValue) {
    console.log(`  Product:    ${productValue}`);
  }

  console.log("\n" + chalk.bold("Environment:"));
  if (isEnvLoaded()) {
    console.log(chalk.green("  Environment variables are loaded in current shell"));
  } else {
    console.log(chalk.yellow("  Environment variables not loaded in current shell"));
    const sourceFile = process.env.SHELL?.includes("fish")
      ? "~/.claude/revenium.fish"
      : "~/.claude/revenium.env";
    console.log(chalk.dim(`  Run: source ${sourceFile}`));
  }

  const shellType = detectShell();
  const profilePath = getProfilePath(shellType);
  console.log(`  Shell:      ${shellType}`);
  if (profilePath) {
    console.log(`  Profile:    ${profilePath}`);
  }

  console.log("\n" + chalk.bold("Endpoint Health:"));
  const spinner = ora("  Testing connectivity...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "claude-code", {
      organizationName: config.organizationName || config.organizationId,
      productName: config.productName || config.productId,
    });

    if (healthResult.healthy) {
      spinner.succeed(`  Endpoint healthy (${healthResult.latencyMs}ms)`);
    } else {
      spinner.fail(`  Endpoint unhealthy: ${healthResult.message}`);
    }
  } catch (error) {
    spinner.fail(
      `  Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  console.log("");
}
