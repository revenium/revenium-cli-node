import chalk from "chalk";
import ora from "ora";
import {
  loadConfig,
  configExists,
  getConfigPath,
  findUnknownConfigKeys,
} from "../config/loader.js";
import { printUnknownConfigKeys } from "../../_core/ui/unknown-config-keys.js";
import {
  GITHUB_CREDENTIAL_MISSING_MESSAGE,
  resolveGithubCredential,
} from "../config/github-credential.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { checkCopilotAccess } from "../core/github-client.js";
import { loadState } from "../core/sync/state-manager.js";
import { countSentRecords } from "../../_core/sync/sent-record-log.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import {
  COPILOT_METRICS_POLICY_HINT,
  ORGANIZATION_UNREACHABLE_HINT,
  SERVICE_NAME,
} from "../constants.js";

async function reportCopilotAccess(token: string, org: string): Promise<void> {
  const spinner = ora("  Testing GitHub Copilot API...").start();
  const access = await checkCopilotAccess(token, org);

  if (access.status === "connected") {
    spinner.succeed("  GitHub Copilot API connected");
    return;
  }

  if (access.status === "organization-unreachable") {
    spinner.fail(`  GitHub organization "${org}" could not be reached with this token`);
    console.log(chalk.dim(`  ${ORGANIZATION_UNREACHABLE_HINT}`));
    return;
  }

  if (access.status === "failed") {
    spinner.fail(`  GitHub Copilot API error: ${access.message}`);
    return;
  }

  spinner.fail("  GitHub Copilot usage metrics could not be read");
  console.log(chalk.dim(`  ${COPILOT_METRICS_POLICY_HINT}`));
}

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

  printUnknownConfigKeys(configPath, await findUnknownConfigKeys());

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("\nCould not parse configuration file"));
    console.log(chalk.yellow("Run `revenium-copilot setup` to reconfigure."));
    process.exit(1);
  }

  const githubCredential = resolveGithubCredential(config);

  console.log("\n" + chalk.bold("Configuration:"));
  if (githubCredential) {
    console.log(`  GitHub Token:     ${maskApiKey(githubCredential.token)}`);
    console.log(`  GitHub Org:       ${githubCredential.orgName}`);
  }
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
    console.log(`  Cached Hashes:    ${countSentRecords(state.sentRecords)}`);
  } else {
    console.log(chalk.yellow("  No sync has been performed yet"));
  }

  console.log("\n" + chalk.bold("Connectivity:"));

  if (githubCredential) {
    await reportCopilotAccess(githubCredential.token, githubCredential.orgName);
  } else {
    console.log(chalk.dim("  GitHub Copilot API not checked — no local GitHub credential"));
    console.log(chalk.dim(`  ${GITHUB_CREDENTIAL_MISSING_MESSAGE}`));
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
