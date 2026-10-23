import chalk from "chalk";

export function printLegacyConfigNotice(): void {
  console.log(
    chalk.yellow("\n  Configuration is outdated: the API key is stored as a resource attribute"),
  );
  console.log(chalk.dim("  Run `revenium-gemini setup` to rewrite it."));
}
