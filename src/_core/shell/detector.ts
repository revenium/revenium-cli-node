import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ShellType } from "../types/index.js";

export function detectShell(): ShellType {
  const shell = process.env.SHELL || "";

  if (shell.includes("zsh")) {
    return "zsh";
  }
  if (shell.includes("fish")) {
    return "fish";
  }
  if (shell.includes("bash")) {
    return "bash";
  }

  const home = homedir();
  if (existsSync(join(home, ".zshrc"))) {
    return "zsh";
  }
  if (existsSync(join(home, ".config", "fish", "config.fish"))) {
    return "fish";
  }
  if (existsSync(join(home, ".bashrc"))) {
    return "bash";
  }

  return "unknown";
}

export function getProfilePath(shellType: ShellType): string | null {
  const home = homedir();

  switch (shellType) {
    case "zsh":
      return join(home, ".zshrc");
    case "bash":
      if (existsSync(join(home, ".bashrc"))) {
        return join(home, ".bashrc");
      }
      return join(home, ".bash_profile");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
    default:
      return null;
  }
}

export function validateConfigPath(path: string): void {
  const unsafeCharsRegex = /[;|&$`"'\\<>(){}[\]!*?#\n\r\t]/;

  if (unsafeCharsRegex.test(path)) {
    throw new Error(
      "Invalid config path: contains unsafe characters. Path must not contain shell metacharacters like semicolons, pipes, backticks, or quotes.",
    );
  }
}
