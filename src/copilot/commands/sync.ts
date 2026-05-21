import chalk from "chalk";
import ora from "ora";
import { writeFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, configExists } from "../config/loader.js";
import { runSyncCycle, SyncWatcher } from "../core/sync/scheduler.js";
import { LOCK_FILE } from "../constants.js";
import type { CopilotConfig, SyncResult } from "../types.js";

interface SyncOptions {
  watch?: boolean;
  from?: string;
  to?: string;
  dryRun?: boolean;
}

function getLockPath(): string {
  return join(tmpdir(), LOCK_FILE);
}

async function acquireLock(): Promise<boolean> {
  try {
    await writeFile(getLockPath(), String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(getLockPath());
  } catch {
    // ignore
  }
}

function formatResult(result: SyncResult): string {
  const parts: string[] = [];
  parts.push(`fetched=${result.fetched}`);
  parts.push(`sent=${result.sent}`);
  if (result.duplicatesSkipped > 0) {
    parts.push(`skipped=${result.duplicatesSkipped}`);
  }
  if (result.errors > 0) {
    parts.push(`errors=${result.errors}`);
  }
  return parts.join(", ");
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-copilot setup` first to configure the integration."));
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  const locked = await acquireLock();
  if (!locked) {
    console.log(chalk.red("Another sync process is already running."));
    console.log(
      chalk.dim(`Lock file: ${getLockPath()}. Remove it manually if the previous process crashed.`),
    );
    process.exit(1);
  }

  const cleanup = async () => {
    await releaseLock();
  };

  const syncReleaseLock = () => {
    try {
      unlinkSync(getLockPath());
    } catch {
      // ignore
    }
  };

  process.on("exit", syncReleaseLock);

  if (options.watch) {
    await runWatchMode(config, cleanup);
  } else {
    await runOnceMode(config, options, cleanup);
  }
}

async function runOnceMode(
  config: CopilotConfig,
  options: SyncOptions,
  cleanup: () => Promise<void>,
): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Sync\n"));

  if (options.dryRun) {
    console.log(chalk.yellow("Running in dry-run mode - no data will be sent\n"));
  }

  const fromDate = options.from || undefined;
  const toDate = options.to || undefined;

  if (options.from && isNaN(new Date(options.from).getTime())) {
    console.log(chalk.red("Invalid --from date format. Use YYYY-MM-DD."));
    await cleanup();
    process.exit(1);
  }

  if (options.to && isNaN(new Date(options.to).getTime())) {
    console.log(chalk.red("Invalid --to date format. Use YYYY-MM-DD."));
    await cleanup();
    process.exit(1);
  }

  const spinner = ora("Syncing usage data...").start();

  try {
    const { result, dryRunPayloads } = await runSyncCycle(config, fromDate, toDate, options.dryRun);
    spinner.succeed(`Sync complete: ${formatResult(result)}`);

    if (options.dryRun && dryRunPayloads && dryRunPayloads.length > 0) {
      console.log("\n" + chalk.dim("OTLP payload(s):"));
      for (const payload of dryRunPayloads) {
        console.log(chalk.dim(JSON.stringify(payload, null, 2)));
      }
    }

    if (result.errors > 0) {
      console.log(chalk.yellow(`\nSome events failed to send (${result.errors} errors)`));
    }
  } catch (error) {
    spinner.fail("Sync failed");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    await cleanup();
    process.exit(1);
  }

  await cleanup();
  console.log("");
}

async function runWatchMode(config: CopilotConfig, cleanup: () => Promise<void>): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Sync (Watch Mode)\n"));
  console.log(
    chalk.dim(
      `Syncing every ${config.syncIntervalMs / 1000 / 60} minutes. Press Ctrl+C to stop.\n`,
    ),
  );

  const watcher = new SyncWatcher(config);
  let stopping = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(chalk.dim("\nGracefully shutting down..."));
    watcher.stop();
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await watcher.start(
    (result) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      if (result.sent > 0 || result.fetched > 0) {
        console.log(chalk.dim(`[${timestamp}]`) + ` ${formatResult(result)}`);
      } else {
        console.log(chalk.dim(`[${timestamp}] no new events`));
      }
    },
    (error) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      console.log(chalk.dim(`[${timestamp}]`) + chalk.red(` error: ${error.message}`));
    },
  );

  await cleanup();
}
