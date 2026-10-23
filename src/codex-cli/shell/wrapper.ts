import type { ShellType } from "../../_core/types/index.js";
import { escapeFishValue, escapeShellValue } from "../../_core/shell/escaping.js";

export const WRAPPER_COMMAND = "revenium-codex run";

function buildLaunchCommand(shellType: ShellType, configPath?: string): string {
  if (!configPath) return `${WRAPPER_COMMAND} --`;

  const quoted = shellType === "fish" ? escapeFishValue(configPath) : escapeShellValue(configPath);
  return `${WRAPPER_COMMAND} --config-path ${quoted} --`;
}

export function getWrapperFunction(shellType: ShellType, configPath?: string): string {
  const launch = buildLaunchCommand(shellType, configPath);

  if (shellType === "fish") {
    return ["function codex", `    ${launch} $argv`, "end"].join("\n");
  }

  return ["codex() {", `    ${launch} "$@"`, "}"].join("\n");
}
