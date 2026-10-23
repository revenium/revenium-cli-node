import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { GEMINI_CONFIG_DIR } from "../constants.js";
import { CONFIG_FILE_MODE, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import { escapeShellValue } from "../../_core/shell/escaping.js";
import { buildGeminiEnv } from "./env.js";
import type { GeminiCliConfig } from "./loader.js";

function getGeminiConfigDir(): string {
  return join(homedir(), GEMINI_CONFIG_DIR);
}

const SOURCE_GUARD = [
  "# Managed by Revenium. Read by `revenium-gemini run`, never by your shell.",
  "# Sourcing this file is a no-op so the API key stays out of your environment.",
  "return 0 2>/dev/null",
];

export function generateEnvContent(config: GeminiCliConfig): string {
  const assignments = Object.entries(buildGeminiEnv(config)).map(
    ([name, value]) => `${name}=${escapeShellValue(value)}`,
  );
  return [...SOURCE_GUARD, ...assignments].join("\n") + "\n";
}

export async function writeConfig(config: GeminiCliConfig): Promise<string> {
  const configPath = getConfigFilePath();

  await mkdir(getGeminiConfigDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath, generateEnvContent(config), { encoding: "utf-8" });
  await chmod(configPath, CONFIG_FILE_MODE);

  return configPath;
}

export function getConfigFilePath(): string {
  return join(getGeminiConfigDir(), REVENIUM_ENV_FILE);
}
