import chalk from "chalk";

export function abortSetup(message?: string): never {
  if (message) {
    console.error("\n" + chalk.red(message) + "\n");
  }
  process.exit(1);
}
