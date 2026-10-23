import { join } from "node:path";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { CONFIG_FILE_MODE, REVENIUM_ENV_FILE, REVENIUM_FISH_FILE } from "../constants.js";
import { escapeShellValue, escapeFishValue } from "./escaping.js";

export interface ShellConfigPaths {
  envPath: string;
  fishPath: string;
}

function serialize(
  env: Record<string, string>,
  formatLine: (name: string, value: string) => string,
): string {
  return (
    Object.entries(env)
      .map(([name, value]) => formatLine(name, value))
      .join("\n") + "\n"
  );
}

async function writeConfigFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf-8", mode: CONFIG_FILE_MODE });
  await chmod(path, CONFIG_FILE_MODE);
}

export async function writeShellConfig(
  configDir: string,
  env: Record<string, string>,
  dirMode: number,
): Promise<ShellConfigPaths> {
  const envPath = join(configDir, REVENIUM_ENV_FILE);
  const fishPath = join(configDir, REVENIUM_FISH_FILE);

  await mkdir(configDir, { recursive: true, mode: dirMode });
  await writeConfigFile(
    envPath,
    serialize(env, (name, value) => `export ${name}=${escapeShellValue(value)}`),
  );
  await writeConfigFile(
    fishPath,
    serialize(env, (name, value) => `set -gx ${name} ${escapeFishValue(value)}`),
  );

  return { envPath, fishPath };
}
