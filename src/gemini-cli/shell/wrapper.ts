import type { ShellType } from "../../_core/types/index.js";

export const WRAPPER_LAUNCH_COMMAND = "revenium-gemini run --";

export function getWrapperFunction(shellType: ShellType): string {
  if (shellType === "fish") {
    return ["function gemini", `    ${WRAPPER_LAUNCH_COMMAND} $argv`, "end"].join("\n");
  }

  return ["gemini() {", `    ${WRAPPER_LAUNCH_COMMAND} "$@"`, "}"].join("\n");
}
