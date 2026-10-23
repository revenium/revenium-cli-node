import chalk from "chalk";
import type { ProjectBreakdownEntry, ProjectSelection } from "../utils/project-selection.js";

export function printProjectBreakdown(breakdown: ProjectBreakdownEntry[], unit: string): void {
  if (breakdown.length === 0) return;
  const width = Math.max(...breakdown.map((entry) => entry.project.length));

  console.log("\n" + chalk.bold("Projects:"));
  for (const entry of breakdown) {
    const line = `  ${entry.project.padEnd(width)}  ${entry.records.toLocaleString()} ${unit}(s)`;
    console.log(entry.included ? line : chalk.dim(`${line}  excluded`));
  }
}

export function reportUnusableSelectors(selection: ProjectSelection<unknown>): boolean {
  for (const entry of selection.ambiguous) {
    console.error(
      chalk.red(
        `\n"${entry.selector}" names more than one project: ${entry.projects.join(", ")}` +
          `\nRe-run naming the full path of the project you meant.`,
      ),
    );
  }
  for (const entry of selection.unmatched) {
    console.error(chalk.red(`\nNo project matches ${entry.flag}: ${entry.selectors.join(", ")}`));
  }
  return selection.ambiguous.length > 0 || selection.unmatched.length > 0;
}
