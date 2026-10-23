import chalk from "chalk";

const RETIRED_KEY_REPLACEMENTS: Record<string, string> = {
  REVENIUM_EMAIL: "REVENIUM_SUBSCRIBER_EMAIL",
};

export function printUnknownConfigKeys(configPath: string, unknownKeys: readonly string[]): void {
  if (unknownKeys.length === 0) {
    return;
  }

  console.log("\n" + chalk.yellow(`Unrecognized settings in ${configPath} (ignored):`));
  for (const key of unknownKeys) {
    const replacement = RETIRED_KEY_REPLACEMENTS[key];
    console.log(chalk.yellow(replacement ? `  ${key} — use ${replacement} instead` : `  ${key}`));
  }
}
