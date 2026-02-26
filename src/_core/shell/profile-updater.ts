import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ShellType, ShellUpdateResult } from "../types/index.js";
import { detectShell, getProfilePath } from "./detector.js";

export interface ProfileUpdaterConfig {
  markerName: string;
  getSourceCommand: (shellType: ShellType, configPath: string) => string;
  getConfigFilePath: () => string;
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

  return before + (after ? "\n" + after : "");
}

async function createBackup(profilePath: string): Promise<void> {
  if (!existsSync(profilePath)) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${profilePath}.revenium-backup-${timestamp}`;
  await copyFile(profilePath, backupPath);

  try {
    const { readdir, unlink, stat } = await import("node:fs/promises");
    const { dirname, basename } = await import("node:path");

    const dir = dirname(profilePath);
    const baseFilename = basename(profilePath);
    const files = await readdir(dir);

    const backupFiles = files
      .filter((f) => f.startsWith(`${baseFilename}.revenium-backup-`))
      .map((f) => ({ name: f, path: `${dir}/${f}` }));

    if (backupFiles.length > 5) {
      const filesWithStats = await Promise.all(
        backupFiles.map(async (f) => ({
          ...f,
          mtime: (await stat(f.path)).mtime,
        })),
      );

      filesWithStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

      const toDelete = filesWithStats.slice(0, filesWithStats.length - 5);
      await Promise.all(toDelete.map((f) => unlink(f.path)));
    }
  } catch {
    // ignore cleanup errors
  }
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

  const configPath = config.getConfigFilePath();
  const markers = getMarkers(config.markerName);

  if (await hasExistingConfig(profilePath, markers.start)) {
    await createBackup(profilePath);
    let content = await readFile(profilePath, "utf-8");
    content = removeExistingConfig(content, markers);
    const configBlock = generateConfigBlock(
      shellType,
      configPath,
      markers,
      config.getSourceCommand,
    );
    await writeFile(profilePath, content + configBlock, "utf-8");

    return {
      success: true,
      shellType,
      profilePath,
      message: `Updated existing configuration in ${profilePath}`,
    };
  }

  let content = "";
  if (existsSync(profilePath)) {
    await createBackup(profilePath);
    content = await readFile(profilePath, "utf-8");
  }

  const configBlock = generateConfigBlock(shellType, configPath, markers, config.getSourceCommand);
  await writeFile(profilePath, content + configBlock, "utf-8");

  return {
    success: true,
    shellType,
    profilePath,
    message: `Added configuration to ${profilePath}`,
  };
}

export function getManualInstructions(config: ProfileUpdaterConfig): string {
  const shellType = detectShell();
  const configPath = config.getConfigFilePath();
  const sourceCmd = config.getSourceCommand(shellType, configPath);
  const profilePath = getProfilePath(shellType);

  return `Add the following to ${profilePath || "your shell profile"}:\n\n${sourceCmd}`;
}
