import { platform } from "node:os";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, unlink, chmod, rename, realpath } from "node:fs/promises";
import { ENV_VARS } from "../constants.js";
import { getClaudeConfigDir } from "./claude-config-dir.js";
import { CONFIG_DIR_MODE, CONFIG_FILE_MODE } from "../../_core/constants.js";
import { backupConfigFile } from "../../_core/config/backup.js";
import { buildClaudeCodeEnv, TELEMETRY_ENV_KEYS } from "./env.js";
import type { ClaudeCodeConfig } from "./loader.js";

export interface HookDefinition {
  type: "command";
  command: string;
}

export interface HookEntry {
  hooks: HookDefinition[];
}

export interface ClaudeSettings {
  env?: Record<string, string>;
  hooks?: {
    [key: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeConfigDir(), "settings.json");
}

// Claude Code's machine-wide settings file, written by MDM rather than by this CLI. It is read to
// tell whether a fleet still registers a hook or overrides a telemetry variable; it is never
// rewritten here.
export function getManagedSettingsPath(): string {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

export async function readSettings(path: string): Promise<ClaudeSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};

    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Unable to read existing settings at ${path}: ${message}. Refusing to overwrite it.`,
      { cause: err },
    ) as NodeJS.ErrnoException;
    wrapped.code = code;
    throw wrapped;
  }

  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid JSON in existing settings at ${path}: ${message}. Refusing to overwrite it.`,
      { cause: err },
    );
  }
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode: CONFIG_FILE_MODE });
    await chmod(tempPath, CONFIG_FILE_MODE);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

// A settings file linked into a dotfiles repository must keep receiving the writes: renaming over
// the link would replace it with a regular file and silently detach the developer's shared config.
async function resolveWriteTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function writeSettings(
  path: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: CONFIG_DIR_MODE });
  const target = await resolveWriteTarget(path);

  await backupConfigFile(target, CONFIG_FILE_MODE);
  await atomicWriteFile(target, JSON.stringify(settings, null, 2) + "\n");
}

export interface TelemetryEnvResult {
  path: string;
  applied: boolean;
  error?: string;
}

// Scopes the telemetry variables to Claude Code's own process: every key this CLI owns is written
// under `env`, every key it no longer configures is dropped, and everything else in the file —
// including `env` entries the developer added — is preserved.
export async function applyTelemetryEnv(config: ClaudeCodeConfig): Promise<TelemetryEnvResult> {
  const path = getClaudeSettingsPath();

  try {
    const settings = await readSettings(path);
    const telemetry = buildClaudeCodeEnv(config);
    const env = { ...settings.env };

    for (const key of TELEMETRY_ENV_KEYS) {
      const value = telemetry[key];
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }

    await writeSettings(path, { ...settings, env });
    return { path, applied: true };
  } catch (error) {
    return { path, applied: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TelemetryEnvReport {
  path: string;
  env: Record<string, string>;
  error?: string;
}

export async function readTelemetryEnv(path: string): Promise<TelemetryEnvReport> {
  try {
    const settings = await readSettings(path);
    const env = settings.env ?? {};
    const telemetry: Record<string, string> = {};

    for (const key of TELEMETRY_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) {
        telemetry[key] = value;
      }
    }

    return { path, env: telemetry };
  } catch (error) {
    return {
      path,
      env: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface TelemetryEnvSources {
  managed: TelemetryEnvReport;
  effective: TelemetryEnvReport;
}

// Claude Code obeys the managed file over the user's own settings, so the effective value of a
// telemetry variable is the merge of the two, not the copy this CLI wrote to revenium.env.
export async function readTelemetryEnvSources(): Promise<TelemetryEnvSources> {
  const settings = await readTelemetryEnv(getClaudeSettingsPath());
  const managed = await readTelemetryEnv(getManagedSettingsPath());

  return {
    managed,
    effective: {
      path: settings.path,
      env: { ...settings.env, ...managed.env },
      error: settings.error,
    },
  };
}

export interface LogToolDetailsResolution {
  value: boolean | undefined;
  unreadablePath?: string;
}

// A settings file that cannot be read may be the one carrying the opt-out, so an unreadable source
// withholds skill names rather than falling back to a value that would send them.
export async function resolveLogToolDetails(
  config: ClaudeCodeConfig,
): Promise<LogToolDetailsResolution> {
  const { managed, effective } = await readTelemetryEnvSources();

  const unreadable = [effective, managed].find((report) => report.error);
  if (unreadable) return { value: false, unreadablePath: unreadable.path };

  const value = effective.env[ENV_VARS.LOG_TOOL_DETAILS];
  if (value === "1") return { value: true };
  if (value === "0") return { value: false };
  return { value: config.logToolDetails };
}
