import chalk from "chalk";
import { launchTool } from "../../_core/process/launch.js";
import { loadConfig } from "../config/loader.js";
import { buildGeminiEnv } from "../config/env.js";

const GEMINI_BINARY = "gemini";
const GEMINI_INSTALL_HINT = "Install Gemini CLI: npm install -g @google/gemini-cli";

async function buildChildEnv(): Promise<NodeJS.ProcessEnv> {
  const config = await loadConfig();

  if (!config) {
    console.error(chalk.yellow("Revenium configuration for Gemini CLI is missing or unreadable."));
    console.error(
      chalk.dim("Starting Gemini CLI without metering. Run `revenium-gemini setup` to restore it."),
    );
    return process.env;
  }

  return { ...process.env, ...buildGeminiEnv(config) };
}

export async function runCommand(args: string[]): Promise<void> {
  launchTool({
    binary: GEMINI_BINARY,
    args,
    env: await buildChildEnv(),
    installHint: GEMINI_INSTALL_HINT,
  });
}
