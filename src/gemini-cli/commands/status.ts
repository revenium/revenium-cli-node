import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists, getConfigPath } from "../config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { LOG_BODY_VALUES, SCOPE_NAMES } from "../../_core/schema/field-registry.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { detectShell, getProfilePath } from "../../_core/shell/detector.js";
import { isProfileConfigured } from "../../_core/shell/profile-updater.js";
import { WRAPPER_LAUNCH_COMMAND } from "../shell/wrapper.js";
import { SHELL_PROFILE_MARKER } from "../constants.js";
import { printLegacyConfigNotice } from "./legacy-notice.js";

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
  if (config.legacy) {
    printLegacyConfigNotice();
  }

  console.log("\n" + chalk.bold("Environment:"));
  const shellType = detectShell();

  if (await isProfileConfigured(SHELL_PROFILE_MARKER, WRAPPER_LAUNCH_COMMAND)) {
    console.log(chalk.green("  Gemini wrapper is installed in the shell profile"));
  } else {
    console.log(chalk.yellow("  Gemini wrapper is not installed in the shell profile"));
    console.log(chalk.dim("  Run: revenium-gemini setup"));
  }

  const profilePath = getProfilePath(shellType);
  console.log(`  Shell:      ${shellType}`);
  if (profilePath) {
    console.log(`  Profile:    ${profilePath}`);
  }

  console.log("\n" + chalk.bold("Endpoint Health:"));
  const spinner = ora("  Testing connectivity...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "gemini-cli", {
      scopeName: SCOPE_NAMES["gemini"],
      bodyValue: LOG_BODY_VALUES["gemini"],
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
