import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists, getConfigPath } from "../config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { testConnectivity } from "../core/github-client.js";
import { loadState } from "../core/sync/state-manager.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { SERVICE_NAME } from "../constants.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Metering Status\n"));

  const configPath = getConfigPath();
  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.dim(`Expected at: ${configPath}`));
    console.log(
      chalk.yellow("\nRun `revenium-copilot setup` to configure GitHub Copilot metering."),
    );
    process.exit(1);
  }

  console.log(chalk.green("Configuration file found"));
  console.log(chalk.dim(`  ${configPath}`));

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("\nCould not parse configuration file"));
    console.log(chalk.yellow("Run `revenium-copilot setup` to reconfigure."));
    process.exit(1);
  }

  console.log("\n" + chalk.bold("Configuration:"));
  console.log(`  GitHub Token:     ${maskApiKey(config.githubToken)}`);
  console.log(`  GitHub Org:       ${config.githubOrg}`);
  console.log(`  Revenium API Key: ${maskApiKey(config.reveniumApiKey)}`);
  console.log(`  Endpoint:         ${config.reveniumEndpoint}`);
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

  const state = await loadState();
  console.log("\n" + chalk.bold("Sync State:"));
  if (state.lastSyncTimestamp > 0) {
    const lastSync = new Date(state.lastSyncTimestamp);
    console.log(`  Last Sync:        ${lastSync.toISOString()}`);
    console.log(`  Last Sync Events: ${state.lastSyncEventCount}`);
    console.log(`  Total Synced:     ${state.totalEventsSynced}`);
    console.log(`  Cached Hashes:    ${state.recentHashes.length}`);
  } else {
    console.log(chalk.yellow("  No sync has been performed yet"));
  }

  console.log("\n" + chalk.bold("Connectivity:"));

  const githubSpinner = ora("  Testing GitHub Copilot API...").start();
  try {
    const githubOk = await testConnectivity(config.githubToken, config.githubOrg);
    if (githubOk) {
      githubSpinner.succeed("  GitHub Copilot API connected");
    } else {
      githubSpinner.fail("  GitHub Copilot API unreachable");
    }
  } catch (error) {
    githubSpinner.fail(
      `  GitHub Copilot API error: ${error instanceof Error ? error.message : "Unknown"}`,
    );
  }

  const reveniumSpinner = ora("  Testing Revenium API...").start();
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

    if (healthResult.healthy) {
      reveniumSpinner.succeed(`  Revenium API healthy (${healthResult.latencyMs}ms)`);
    } else {
      reveniumSpinner.fail(`  Revenium API unhealthy: ${healthResult.message}`);
    }
  } catch (error) {
    reveniumSpinner.fail(
      `  Revenium API error: ${error instanceof Error ? error.message : "Unknown"}`,
    );
  }

  console.log("");
}
