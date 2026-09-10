import chalk from "chalk";

const SYNC_REMOVAL_VERSION = "2.0.0";

export interface SyncDeprecationNotice {
  command: string;
  dashboardPath: string;
}

export function printSyncDeprecationNotice({
  command,
  dashboardPath,
}: SyncDeprecationNotice): void {
  console.log(
    "\n" +
      chalk.yellow.bold(
        `\`${command}\` is deprecated and will be removed in ${SYNC_REMOVAL_VERSION}.`,
      ),
  );
  console.log(
    chalk.dim(
      `Add the credential under ${dashboardPath} in the Revenium dashboard instead. Revenium then syncs it automatically, with no process left running.`,
    ),
  );
  console.log(chalk.dim("`backfill`, `status` and `test` are unaffected.\n"));
}
