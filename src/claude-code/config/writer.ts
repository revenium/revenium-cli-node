import { join } from "node:path";
import { writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { CONFIG_DIR_MODE, CONFIG_FILE_MODE, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import { escapeShellValue } from "../../_core/shell/escaping.js";
import { buildClaudeCodeEnv } from "./env.js";
import { getFixedClaudeHomeDir } from "./claude-config-dir.js";
import type { ClaudeCodeConfig } from "./loader.js";

const LEGACY_FISH_FILE = "revenium.fish";

const SOURCE_GUARD = [
  "# Managed by Revenium. Read by the Revenium CLI, never by your shell.",
  "# Sourcing this file is a no-op so the API key stays out of your environment.",
  "return 0 2>/dev/null",
];

export function generateEnvContent(config: ClaudeCodeConfig): string {
  const assignments = Object.entries(buildClaudeCodeEnv(config)).map(
    ([name, value]) => `${name}=${escapeShellValue(value)}`,
  );
  return [...SOURCE_GUARD, ...assignments].join("\n") + "\n";
}

export async function writeConfig(config: ClaudeCodeConfig): Promise<string> {
  const configPath = getConfigFilePath();

  await mkdir(getFixedClaudeHomeDir(), { recursive: true, mode: CONFIG_DIR_MODE });
  await writeFile(configPath, generateEnvContent(config), {
    encoding: "utf-8",
    mode: CONFIG_FILE_MODE,
  });
  await chmod(configPath, CONFIG_FILE_MODE);
  await rm(getFishConfigFilePath(), { force: true });

  return configPath;
}

export function getConfigFilePath(): string {
  return join(getFixedClaudeHomeDir(), REVENIUM_ENV_FILE);
}

function getFishConfigFilePath(): string {
  return join(getFixedClaudeHomeDir(), LEGACY_FISH_FILE);
}
