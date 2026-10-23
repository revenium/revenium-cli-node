import chalk from "chalk";

export function printWriteKeyWarning(): void {
  console.log(
    "\n" +
      chalk.yellow.bold(
        "This is a full-access write key (rev_sk_): it can change products, subscriptions, API keys and customers for your whole organization.",
      ),
  );
  console.log(
    chalk.yellow("Setup stores it on this machine, where any program running as you can read it."),
  );
  console.log(chalk.yellow("Use a metering key (rev_mk_) from the Revenium dashboard instead.\n"));
}
