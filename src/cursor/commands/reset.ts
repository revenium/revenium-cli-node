import chalk from "chalk";
import ora from "ora";
import { configExists } from "../config/loader.js";
import { resetState, loadState } from "../core/sync/state-manager.js";

export async function resetCommand(): Promise<void> {
  console.log(chalk.bold("\nRevenium Cursor IDE Metering Reset\n"));

  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-cursor setup` first to configure the integration."));
    process.exit(1);
  }

  const state = await loadState();

  if (state.lastSyncTimestamp === 0) {
    console.log(chalk.yellow("No sync state to reset."));
    console.log("");
    return;
  }

  console.log(chalk.bold("Current state:"));
  console.log(`  Last Sync:        ${new Date(state.lastSyncTimestamp).toISOString()}`);
  console.log(`  Total Synced:     ${state.totalEventsSynced}`);
  console.log(`  Cached Hashes:    ${state.recentHashes.length}`);

  const spinner = ora("Resetting sync state...").start();

  try {
    await resetState();
    spinner.succeed("Sync state reset successfully");
    console.log(chalk.dim("\nNext sync will start fresh. Run `revenium-cursor sync` to begin."));
  } catch (error) {
    spinner.fail("Failed to reset state");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  console.log("");
}
