import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists, isEnvLoaded, getConfigPath } from "../config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { detectShell, getProfilePath } from "../../_core/shell/detector.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold("\nRevenium Gemini CLI Metering Status\n"));

  const configPath = getConfigPath();
  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.dim(`Expected at: ${configPath}`));
    console.log(chalk.yellow("\nRun `revenium-gemini setup` to configure Gemini CLI metering."));
    process.exit(1);
  }

  console.log(chalk.green("Configuration file found"));
  console.log(chalk.dim(`  ${configPath}`));

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("\nCould not parse configuration file"));
    console.log(chalk.yellow("Run `revenium-gemini setup` to reconfigure."));
    process.exit(1);
  }

  console.log("\n" + chalk.bold("Configuration:"));
  console.log(`  API Key:    ${maskApiKey(config.apiKey)}`);
  console.log(`  Endpoint:   ${config.endpoint}`);
  if (config.email) {
    console.log(`  Email:      ${maskEmail(config.email)}`);
  }
  if (config.organizationName) {
    console.log(`  Organization: ${config.organizationName}`);
  }
  if (config.productName) {
    console.log(`  Product:    ${config.productName}`);
  }
  if (config.costMultiplier !== undefined) {
    console.log(`  Cost Multiplier: ${config.costMultiplier}`);
  }

  console.log("\n" + chalk.bold("Environment:"));
  const shellType = detectShell();
  const configFile = shellType === "fish" ? "~/.gemini/revenium.fish" : "~/.gemini/revenium.env";

  if (isEnvLoaded()) {
    console.log(chalk.green("  Environment variables are loaded in current shell"));
  } else {
    console.log(chalk.yellow("  Environment variables not loaded in current shell"));
    console.log(chalk.dim(`  Run: source ${configFile}`));
  }

  const profilePath = getProfilePath(shellType);
  console.log(`  Shell:      ${shellType}`);
  if (profilePath) {
    console.log(`  Profile:    ${profilePath}`);
  }

  console.log("\n" + chalk.bold("Endpoint Health:"));
  const spinner = ora("  Testing connectivity...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "gemini-cli");

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
