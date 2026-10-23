import chalk from "chalk";
import { launchTool } from "../../_core/process/launch.js";
import { buildCodexEnv, loadCodexAttribution } from "../config/env.js";

const CODEX_BINARY = "codex";
const CODEX_INSTALL_HINT = "Install Codex CLI: npm install -g @openai/codex";

export interface RunOptions {
  configPath?: string;
}

async function buildChildEnv(configPath?: string): Promise<NodeJS.ProcessEnv> {
  const attribution = await loadCodexAttribution(configPath);

  if (!attribution) {
    console.error(chalk.yellow("Revenium configuration for Codex CLI is missing or unreadable."));
    console.error(
      chalk.dim(
        "Starting Codex CLI without attribution. Run `revenium-codex setup` to restore it.",
      ),
    );
    return process.env;
  }

  return { ...process.env, ...buildCodexEnv(attribution) };
}

export async function runCommand(args: string[], options: RunOptions = {}): Promise<void> {
  launchTool({
    binary: CODEX_BINARY,
    args,
    env: await buildChildEnv(options.configPath),
    installHint: CODEX_INSTALL_HINT,
  });
}
