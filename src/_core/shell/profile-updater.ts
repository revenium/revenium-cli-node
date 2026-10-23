import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ShellType, ShellUpdateResult } from "../types/index.js";
import { detectShell, getProfilePath } from "./detector.js";
import { backupConfigFile } from "../config/backup.js";

const KNOWN_SHELL_TYPES: ShellType[] = ["bash", "zsh", "fish"];

export interface ProfileUpdaterConfig {
  markerName: string;
  getSourceCommand: (shellType: ShellType, configPath: string) => string;
  getConfigFilePath: () => string;
  pruneOtherProfiles?: boolean;
}

function getMarkers(markerName: string) {
  return {
    start: `# >>> ${markerName} >>>`,
    end: `# <<< ${markerName} <<<`,
  };
}

async function hasExistingConfig(profilePath: string, markerStart: string): Promise<boolean> {
  if (!existsSync(profilePath)) {
    return false;
  }

  const content = await readFile(profilePath, "utf-8");
  return content.includes(markerStart);
}

function extractConfigBlock(
  content: string,
  markers: { start: string; end: string },
): string | null {
  const startIndex = content.indexOf(markers.start);
  const endIndex = content.indexOf(markers.end);

  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  return content.substring(startIndex, endIndex + markers.end.length);
}

function generateConfigBlock(
  shellType: ShellType,
  configPath: string,
  markers: { start: string; end: string },
  getSourceCommand: (shellType: ShellType, configPath: string) => string,
): string {
  const sourceCmd = getSourceCommand(shellType, configPath);
  return `\n${markers.start}\n${sourceCmd}\n${markers.end}\n`;
}

function removeExistingConfig(content: string, markers: { start: string; end: string }): string {
  const startIndex = content.indexOf(markers.start);
  const endIndex = content.indexOf(markers.end);

  if (startIndex === -1 || endIndex === -1) {
    return content;
  }

  const before = content.substring(0, startIndex).trimEnd();
  const after = content.substring(endIndex + markers.end.length).trimStart();

  if (after) {
    return before + "\n" + after;
  }
  // Appenders such as `echo 'export X=1' >> ~/.zshrc` concatenate onto the last line when the
  // trailing newline is dropped, corrupting both the previous line and the new one.
  return before + (content.endsWith("\n") ? "\n" : "");
}

async function stripConfigFromProfile(
  path: string,
  markers: { start: string; end: string },
): Promise<boolean> {
  if (!(await hasExistingConfig(path, markers.start))) return false;

  await backupConfigFile(path);
  const content = await readFile(path, "utf-8");
  await writeFile(path, removeExistingConfig(content, markers), "utf-8");
  return true;
}

async function pruneConfigFromOtherProfiles(
  markers: { start: string; end: string },
  keepProfilePath: string,
): Promise<void> {
  const otherPaths = new Set(
    KNOWN_SHELL_TYPES.map(getProfilePath).filter(
      (path): path is string => path !== null && path !== keepProfilePath,
    ),
  );

  for (const path of otherPaths) {
    await stripConfigFromProfile(path, markers);
  }
}

/**
 * Removes a previously installed block from every known shell profile and reports the ones it
 * changed. A profile that cannot be read or written is skipped rather than failing the caller:
 * this runs inside `setup`, which must still finish configuring metering.
 */
export async function removeShellProfileConfig(markerName: string): Promise<string[]> {
  const markers = getMarkers(markerName);
  const paths = new Set(
    KNOWN_SHELL_TYPES.map(getProfilePath).filter((path): path is string => path !== null),
  );

  const removed: string[] = [];
  for (const path of paths) {
    try {
      if (await stripConfigFromProfile(path, markers)) {
        removed.push(path);
      }
    } catch {}
  }

  return removed;
}

async function installConfigBlock(
  shellType: ShellType,
  profilePath: string,
  markers: { start: string; end: string },
  config: ProfileUpdaterConfig,
): Promise<ShellUpdateResult> {
  const replacesExistingConfig = await hasExistingConfig(profilePath, markers.start);
  let content = "";

  if (existsSync(profilePath)) {
    await backupConfigFile(profilePath);
    content = removeExistingConfig(await readFile(profilePath, "utf-8"), markers);
  }

  const configBlock = generateConfigBlock(
    shellType,
    config.getConfigFilePath(),
    markers,
    config.getSourceCommand,
  );
  await writeFile(profilePath, content + configBlock, "utf-8");

  return {
    success: true,
    shellType,
    profilePath,
    message: replacesExistingConfig
      ? `Updated existing configuration in ${profilePath}`
      : `Added configuration to ${profilePath}`,
  };
}

export async function updateShellProfile(config: ProfileUpdaterConfig): Promise<ShellUpdateResult> {
  const shellType = detectShell();

  if (shellType === "unknown") {
    return {
      success: false,
      shellType,
      message:
        "Could not detect shell type. Please manually add the source command to your shell profile.",
    };
  }

  const profilePath = getProfilePath(shellType);

  if (!profilePath) {
    return {
      success: false,
      shellType,
      message: `Could not determine profile path for ${shellType}.`,
    };
  }

  const markers = getMarkers(config.markerName);
  const result = await installConfigBlock(shellType, profilePath, markers, config);

  if (!config.pruneOtherProfiles) {
    return result;
  }

  try {
    await pruneConfigFromOtherProfiles(markers, profilePath);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      ...result,
      message: `${result.message}. Could not clean up other shell profiles: ${reason}`,
    };
  }
}

export async function isProfileConfigured(
  markerName: string,
  requiredContent?: string,
): Promise<boolean> {
  const profilePath = getProfilePath(detectShell());
  if (!profilePath || !existsSync(profilePath)) return false;

  const content = await readFile(profilePath, "utf-8");
  const block = extractConfigBlock(content, getMarkers(markerName));
  if (!block) return false;

  return !requiredContent || block.includes(requiredContent);
}

export function getManualInstructions(config: ProfileUpdaterConfig): string {
  const shellType = detectShell();
  const configPath = config.getConfigFilePath();
  const sourceCmd = config.getSourceCommand(shellType, configPath);
  const profilePath = getProfilePath(shellType);

  return `Add the following to ${profilePath || "your shell profile"}:\n\n${sourceCmd}`;
}
