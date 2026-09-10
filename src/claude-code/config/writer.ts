import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod, rename, unlink } from "node:fs/promises";
import {
  CLAUDE_HOME_DIR_NAME,
  ENV_VARS,
  MIDDLEWARE_SOURCE_KEY,
  MIDDLEWARE_SOURCE_CLI,
} from "../constants.js";
import { CONFIG_FILE_MODE, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import {
  escapeDoubleQuotedShellValue,
  escapeFishValue,
  escapeResourceAttributeValue,
} from "../../_core/shell/escaping.js";
import { parseEnvContent } from "../../_core/config/loader.js";
import { getConfigPath, getFishConfigPath, getFullOtlpEndpoint } from "./loader.js";
import type { ClaudeCodeConfig } from "./loader.js";

function getClaudeConfigDir(): string {
  return join(homedir(), CLAUDE_HOME_DIR_NAME);
}

function buildResourceAttributePairs(config: ClaudeCodeConfig): string[] {
  const resourceAttrs: string[] = [
    `${MIDDLEWARE_SOURCE_KEY}=${escapeResourceAttributeValue(MIDDLEWARE_SOURCE_CLI)}`,
  ];

  if (config.email) {
    resourceAttrs.push(`user.email=${escapeResourceAttributeValue(config.email)}`);
  }

  if (config.organizationName) {
    resourceAttrs.push(
      `organization.name=${escapeResourceAttributeValue(config.organizationName)}`,
    );
  }

  if (config.productName) {
    resourceAttrs.push(`product.name=${escapeResourceAttributeValue(config.productName)}`);
  }

  return resourceAttrs;
}

export function generateEnvContent(config: ClaudeCodeConfig): string {
  const fullEndpoint = getFullOtlpEndpoint(config.endpoint);

  const lines: string[] = [
    `export ${ENV_VARS.TELEMETRY_ENABLED}=1`,
    "",
    `export ${ENV_VARS.OTLP_ENDPOINT}=${escapeDoubleQuotedShellValue(fullEndpoint)}`,
    "",
    `export ${ENV_VARS.OTLP_HEADERS}=${escapeDoubleQuotedShellValue(`x-api-key=${config.apiKey}`)}`,
    "",
    `export ${ENV_VARS.OTLP_PROTOCOL}=http/json`,
    "",
    "export OTEL_LOGS_EXPORTER=otlp",
    "",
    // Claude Code redacts skill names on skill_activated unless tool details are logged, which
    // leaves plugin skills unattributable in Revenium. Also exports tool inputs (Bash command
    // text, MCP tool names); never prompts or model output.
    `export ${ENV_VARS.LOG_TOOL_DETAILS}=${config.logToolDetails === false ? 0 : 1}`,
  ];

  if (config.email) {
    lines.push("");
    lines.push(`export ${ENV_VARS.SUBSCRIBER_EMAIL}=${escapeDoubleQuotedShellValue(config.email)}`);
  }

  if (config.extraUsageEnabled !== undefined) {
    lines.push("");
    lines.push(`export ${ENV_VARS.EXTRA_USAGE_ENABLED}=${config.extraUsageEnabled ? 1 : 0}`);
  }

  if (config.teamId) {
    lines.push("");
    lines.push(`export ${ENV_VARS.TEAM_ID}=${escapeDoubleQuotedShellValue(config.teamId)}`);
  }

  if (config.managementEndpoint) {
    lines.push("");
    lines.push(
      `export ${ENV_VARS.MGMT_ENDPOINT}=${escapeDoubleQuotedShellValue(config.managementEndpoint)}`,
    );
  }

  const resourceAttrs = buildResourceAttributePairs(config);
  lines.push("");
  lines.push(`export OTEL_RESOURCE_ATTRIBUTES="${resourceAttrs.join(",")}"`);

  lines.push("");
  return lines.join("\n");
}

export function generateFishContent(config: ClaudeCodeConfig): string {
  const fullEndpoint = getFullOtlpEndpoint(config.endpoint);

  const lines: string[] = [
    `set -gx ${ENV_VARS.TELEMETRY_ENABLED} 1`,
    "",
    `set -gx ${ENV_VARS.OTLP_ENDPOINT} ${escapeFishValue(fullEndpoint)}`,
    "",
    `set -gx ${ENV_VARS.OTLP_HEADERS} ${escapeFishValue(`x-api-key=${config.apiKey}`)}`,
    "",
    `set -gx ${ENV_VARS.OTLP_PROTOCOL} http/json`,
    "",
    "set -gx OTEL_LOGS_EXPORTER otlp",
    "",
    `set -gx ${ENV_VARS.LOG_TOOL_DETAILS} ${config.logToolDetails === false ? 0 : 1}`,
  ];

  if (config.email) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.SUBSCRIBER_EMAIL} ${escapeFishValue(config.email)}`);
  }

  if (config.extraUsageEnabled !== undefined) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.EXTRA_USAGE_ENABLED} ${config.extraUsageEnabled ? 1 : 0}`);
  }

  if (config.teamId) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.TEAM_ID} ${escapeFishValue(config.teamId)}`);
  }

  if (config.managementEndpoint) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.MGMT_ENDPOINT} ${escapeFishValue(config.managementEndpoint)}`);
  }

  const resourceAttrs = buildResourceAttributePairs(config);
  lines.push("");
  lines.push(`set -gx OTEL_RESOURCE_ATTRIBUTES ${escapeFishValue(resourceAttrs.join(","))}`);

  lines.push("");
  return lines.join("\n");
}

export async function writeConfig(
  config: ClaudeCodeConfig,
): Promise<{ envPath: string; fishPath: string }> {
  const configDir = getClaudeConfigDir();
  const configPath = join(configDir, REVENIUM_ENV_FILE);
  const fishConfigPath = join(configDir, "revenium.fish");

  await mkdir(configDir, { recursive: true });

  const content = generateEnvContent(config);
  await writeFile(configPath, content, { encoding: "utf-8" });
  await chmod(configPath, CONFIG_FILE_MODE);

  const fishContent = generateFishContent(config);
  await writeFile(fishConfigPath, fishContent, { encoding: "utf-8" });
  await chmod(fishConfigPath, CONFIG_FILE_MODE);

  return { envPath: configPath, fishPath: fishConfigPath };
}

export function getConfigFilePath(): string {
  return join(getClaudeConfigDir(), REVENIUM_ENV_FILE);
}

export type ToolDetailsUpgradeStatus = "added" | "already-set" | "no-file";

export interface ToolDetailsUpgradeResult {
  path: string;
  status: ToolDetailsUpgradeStatus;
}

const TOOL_DETAILS_UPGRADE_COMMENT =
  "# Added by `revenium-metering status --fix`: without this, Claude Code redacts skill\n" +
  "# names on skill_activated and Revenium cannot attribute plugin skill usage. It also\n" +
  "# exports tool inputs (Bash command text, MCP tool names); never prompts or model output.";

function appendToolDetailsLine(content: string, exportLine: string): string {
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}\n${TOOL_DETAILS_UPGRADE_COMMENT}\n${exportLine}\n`;
}

/**
 * Writes `content` to `path` without ever leaving a truncated file behind: the new content lands
 * in a sibling temp file first, then an atomic rename replaces the original in one step. A crash
 * or failure mid-write leaves either the old file or the new one intact, never a half-written one.
 */
async function atomicWriteFile(path: string, content: string, mode: number): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function upgradeOneFile(path: string, isFish: boolean): Promise<ToolDetailsUpgradeResult> {
  if (!existsSync(path)) {
    return { path, status: "no-file" };
  }

  const content = await readFile(path, "utf-8");
  const parsed = parseEnvContent(content, isFish);

  // An explicit opt-out (`=0`) is a deliberate choice and is left alone.
  if (parsed[ENV_VARS.LOG_TOOL_DETAILS] !== undefined) {
    return { path, status: "already-set" };
  }

  const exportLine = isFish
    ? `set -gx ${ENV_VARS.LOG_TOOL_DETAILS} 1`
    : `export ${ENV_VARS.LOG_TOOL_DETAILS}=1`;

  await atomicWriteFile(path, appendToolDetailsLine(content, exportLine), CONFIG_FILE_MODE);

  return { path, status: "added" };
}

/**
 * Adds `OTEL_LOG_TOOL_DETAILS=1` to config files written before the flag existed.
 * Idempotent: a file that already sets the variable (to any value) is left untouched.
 *
 * The fish companion is only upgraded when it resolves to a *different* path than the primary
 * config. A `REVENIUM_CONFIG_PATH` override without a `.env` suffix has no separate fish file, and
 * processing the same file twice (once as bash, once as fish) would corrupt it.
 */
export async function ensureToolDetailsExport(): Promise<ToolDetailsUpgradeResult[]> {
  const envPath = getConfigPath();
  const fishPath = getFishConfigPath(envPath);

  const results = [await upgradeOneFile(envPath, false)];
  if (fishPath !== envPath) {
    results.push(await upgradeOneFile(fishPath, true));
  }

  return results;
}
