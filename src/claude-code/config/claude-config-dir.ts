import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_HOME_DIR_NAME, CLAUDE_PROJECTS_DIR_NAME, ENV_VARS } from "../constants.js";

// A whitespace-only override is treated as unset: trusting it verbatim would point every caller at
// a directory named " " instead of falling back to ~/.claude, and the legacy-gate cleanup would
// then report nothing to clean on a machine that has the old hook registered.
export function getClaudeConfigDir(): string {
  return process.env[ENV_VARS.CLAUDE_CONFIG_DIR]?.trim() || join(homedir(), CLAUDE_HOME_DIR_NAME);
}

export function getClaudeProjectsDir(): string {
  return join(getClaudeConfigDir(), CLAUDE_PROJECTS_DIR_NAME);
}

// Deliberately ignores CLAUDE_CONFIG_DIR: the ticket-gate shell scripts read
// ${HOME}/.claude/revenium.env literally, so that file is relocated only by REVENIUM_CONFIG_PATH.
export function getFixedClaudeHomeDir(): string {
  return join(homedir(), CLAUDE_HOME_DIR_NAME);
}
