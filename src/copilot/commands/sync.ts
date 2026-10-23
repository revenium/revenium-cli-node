import chalk from "chalk";
import ora from "ora";
import { writeFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { printSyncDeprecationNotice } from "../../_core/ui/deprecation.js";
import { loadConfig, configExists } from "../config/loader.js";
import {
  GITHUB_CREDENTIAL_HINT,
  GITHUB_CREDENTIAL_MISSING_MESSAGE,
  type GithubCredential,
  type GithubCredentialOverrides,
  resolveGithubCredential,
} from "../config/github-credential.js";
import { runSyncCycle, SyncWatcher } from "../core/sync/scheduler.js";
import { OrganizationUnreachableError } from "../core/github-client.js";
import { countWithheldRecords, createBillingReport } from "../core/billing-match.js";
import { createBillingReportPrinter, printBillingReport } from "../ui/billing-report.js";
import { LOCK_FILE } from "../constants.js";
import type { BillingReport, CopilotConfig, SyncResult } from "../types.js";

const ALLOW_MISSING_BILLING_HINT =
  "Pass --allow-missing-billing to import their usage at zero cost instead.";

const BILLING_REMEDY = `The sync window is held at those days, so they are imported on the first run whose token can read billing. ${ALLOW_MISSING_BILLING_HINT}`;

function earliestUnavailableDay(report: BillingReport): string | undefined {
  return report.unavailable.map((entry) => entry.day).sort()[0];
}

function billingRemedy(report: BillingReport, fromDate?: string): string {
  if (!fromDate) return BILLING_REMEDY;

  const earliest = earliestUnavailableDay(report) ?? fromDate;
  return `A historical run does not rewind saved sync progress, so those days are not fetched again on their own: re-run \`sync --from ${earliest}\` once the token can read billing. ${ALLOW_MISSING_BILLING_HINT}`;
}

interface SyncOptions extends GithubCredentialOverrides {
  watch?: boolean;
  from?: string;
  to?: string;
  dryRun?: boolean;
  allowMissingBilling?: boolean;
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
  printSyncDeprecationNotice({
    command: "revenium-copilot sync",
    dashboardPath: "Connections > Providers > GitHub Copilot",
  });

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

  const githubCredential = resolveGithubCredential(config, options);
  if (!githubCredential) {
    console.log(chalk.red(GITHUB_CREDENTIAL_MISSING_MESSAGE));
    console.log(chalk.yellow(GITHUB_CREDENTIAL_HINT));
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
    await runWatchMode(config, githubCredential, options, cleanup);
  } else {
    await runOnceMode(config, githubCredential, options, cleanup);
  }
}

async function runOnceMode(
  config: CopilotConfig,
  githubCredential: GithubCredential,
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
  const billingReport = createBillingReport();

  try {
    const { result, dryRunPayloads } = await runSyncCycle(config, githubCredential, {
      from: fromDate,
      to: toDate,
      dryRun: options.dryRun,
      allowMissingBilling: options.allowMissingBilling,
      billingReport,
    });
    const incomplete =
      result.errors > 0 || (!options.dryRun && countWithheldRecords(billingReport) > 0);

    if (incomplete) {
      spinner.warn(`Sync incomplete: ${formatResult(result)}`);
    } else {
      spinner.succeed(`Sync complete: ${formatResult(result)}`);
    }

    printBillingReport(billingReport, billingRemedy(billingReport, fromDate));

    if (options.dryRun && dryRunPayloads && dryRunPayloads.length > 0) {
      console.log("\n" + chalk.dim("OTLP payload(s):"));
      for (const payload of dryRunPayloads) {
        console.log(chalk.dim(JSON.stringify(payload, null, 2)));
      }
    }

    if (result.errors > 0) {
      console.log(
        chalk.yellow(
          `\nRevenium did not accept ${result.errors} event(s). They stay in the sync window and are retried on the next sync.`,
        ),
      );
    }

    if (incomplete) {
      await cleanup();
      process.exit(1);
    }
  } catch (error) {
    spinner.fail("Sync failed");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    printBillingReport(billingReport, billingRemedy(billingReport, fromDate));
    await cleanup();
    process.exit(1);
  }

  await cleanup();
  console.log("");
}

async function runWatchMode(
  config: CopilotConfig,
  githubCredential: GithubCredential,
  options: SyncOptions,
  cleanup: () => Promise<void>,
): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Sync (Watch Mode)\n"));
  console.log(
    chalk.dim(
      `Syncing every ${config.syncIntervalMs / 1000 / 60} minutes. Press Ctrl+C to stop.\n`,
    ),
  );

  const watcher = new SyncWatcher(config, githubCredential, options.allowMissingBilling);
  let stopping = false;
  let withheldRecordsDuringRun = false;
  let organizationUnreachable = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(chalk.dim("\nGracefully shutting down..."));
    watcher.stop();
    await cleanup();
    process.exit(withheldRecordsDuringRun ? 1 : 0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const printBillingOnce = createBillingReportPrinter(BILLING_REMEDY);

  const reportBilling = (timestamp: string, billingReport: BillingReport) => {
    const withheldRecords = countWithheldRecords(billingReport);
    withheldRecordsDuringRun = withheldRecordsDuringRun || withheldRecords > 0;

    if (withheldRecords > 0) {
      console.log(
        chalk.dim(`[${timestamp}]`) +
          chalk.red(
            ` billing unavailable for ${billingReport.unavailable.length} day(s), ${withheldRecords} record(s) withheld`,
          ),
      );
    }
    printBillingOnce(billingReport);
  };

  await watcher.start(
    (result, billingReport) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      if (result.sent > 0 || result.fetched > 0) {
        console.log(chalk.dim(`[${timestamp}]`) + ` ${formatResult(result)}`);
      } else {
        console.log(chalk.dim(`[${timestamp}] no new events`));
      }
      reportBilling(timestamp, billingReport);
    },
    (error, billingReport) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      console.log(chalk.dim(`[${timestamp}]`) + chalk.red(` error: ${error.message}`));
      reportBilling(timestamp, billingReport);

      if (error instanceof OrganizationUnreachableError) {
        organizationUnreachable = true;
        watcher.stop();
      }
    },
  );

  await cleanup();

  if (organizationUnreachable) process.exit(1);
}
