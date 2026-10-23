import chalk from "chalk";
import { ENV_KEYS, LEGACY_CURSOR_API_KEY } from "../constants.js";

export function printLegacyKeyNameRewritten(configPaths: readonly string[]): void {
  console.log(
    chalk.yellow(
      `\n  The Cursor admin key was stored as ${LEGACY_CURSOR_API_KEY}, the name Cursor's own tools read.`,
    ),
  );
  console.log(
    chalk.dim(
      `  ${configPaths.join(", ")} now store it as ${ENV_KEYS.REVENIUM_CURSOR_API_KEY}. Open a new terminal so the old value stops being exported.`,
    ),
  );
}

export function printLegacyKeyNameRewriteFailed(configPaths: readonly string[]): void {
  console.log(
    chalk.yellow(
      `\n  The Cursor admin key is still stored as ${LEGACY_CURSOR_API_KEY}, the name Cursor's own tools read.`,
    ),
  );
  console.log(chalk.dim(`  ${configPaths.join(", ")} could not be rewritten; check permissions.`));
}
