import { DIR_MODE } from "../constants.js";
import { writeShellConfig, type ShellConfigPaths } from "../../_core/shell/config-writer.js";
import type { CopilotConfig } from "../types.js";
import { getConfigDir } from "./loader.js";
import { buildCopilotEnv } from "./env.js";

export async function writeConfig(config: CopilotConfig): Promise<ShellConfigPaths> {
  return writeShellConfig(getConfigDir(), buildCopilotEnv(config), DIR_MODE);
}
