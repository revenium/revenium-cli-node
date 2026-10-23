import { DIR_MODE } from "../constants.js";
import { writeShellConfig, type ShellConfigPaths } from "../../_core/shell/config-writer.js";
import type { CursorConfig } from "../types.js";
import { getConfigDir } from "./loader.js";
import { buildCursorEnv } from "./env.js";

export async function writeConfig(config: CursorConfig): Promise<ShellConfigPaths> {
  return writeShellConfig(getConfigDir(), buildCursorEnv(config), DIR_MODE);
}
