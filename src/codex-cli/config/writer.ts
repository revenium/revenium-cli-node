import { dirname } from "node:path";
import { writeFile, mkdir, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CODEX_ENV_KEYS } from "../constants.js";
import { CONFIG_DIR_MODE, CONFIG_FILE_MODE, DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { escapeShellValue } from "../../_core/shell/escaping.js";
import { extractBaseEndpoint, getFullOtlpEndpoint } from "../../_core/config/loader.js";
import { backupConfigFile } from "../../_core/config/backup.js";
import { getCodexConfigPath, getReveniumEnvPath } from "./loader.js";
import { findOtelEntries } from "./otel-entries.js";
import { readTableBody, scanTomlLines, statementEndLine, type TomlLine } from "./toml-lines.js";

export interface CodexOtelConfig {
  apiKey: string;
  endpoint?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  logToolDetails?: boolean;
}

function escapeTomlString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export function resolveBaseEndpoint(config: CodexOtelConfig): string {
  return extractBaseEndpoint(config.endpoint ?? DEFAULT_REVENIUM_URL);
}

function buildExporterLine(config: CodexOtelConfig): string {
  if (config.logToolDetails === false) return `exporter = "none"`;

  const logsEndpoint = `${getFullOtlpEndpoint(resolveBaseEndpoint(config))}/v1/logs`;

  return `exporter = { otlp-http = { endpoint = "${escapeTomlString(logsEndpoint)}", protocol = "json", headers = { "x-api-key" = "${escapeTomlString(config.apiKey)}" } } }`;
}

export function generateTomlBlock(config: CodexOtelConfig): string {
  const lines: string[] = [
    "[otel]",
    buildExporterLine(config),
    `metrics_exporter = "none"`,
    "log_user_prompt = false",
    "",
    "[features]",
    "runtime_metrics = true",
    "",
  ];

  return lines.join("\n");
}

const FEATURES_TABLE = "features";

function lastBodyLineKeepingComments(
  lines: TomlLine[],
  headerLine: number,
  endLine: number,
): number {
  let line = endLine;
  let hasComment = false;

  while (line > headerLine) {
    const trimmed = lines[line - 1].text.trim();
    if (trimmed.startsWith("#")) hasComment = true;
    else if (trimmed !== "") break;
    line--;
  }

  return hasComment ? line : endLine;
}

function tableEndLine(lines: TomlLine[], headerLine: number): number {
  let endLine = headerLine;
  let line = headerLine + 1;

  while (line <= lines.length && lines[line - 1].segments === null) {
    endLine = statementEndLine(lines, line);
    line = endLine + 1;
  }

  return lastBodyLineKeepingComments(lines, headerLine, endLine);
}

function markLines(removedLines: Set<number>, from: number, to: number): void {
  for (let line = from; line <= to; line++) removedLines.add(line);
}

function removeManagedSections(text: string): string {
  const lines = scanTomlLines(text);
  const removedLines = new Set<number>();

  for (const entry of findOtelEntries(text)) {
    const endLine =
      entry.kind === "table"
        ? tableEndLine(lines, entry.line)
        : statementEndLine(lines, entry.line);
    markLines(removedLines, entry.line, endLine);
  }

  lines.forEach((line, index) => {
    if (line.segments?.[0] === FEATURES_TABLE) {
      markLines(removedLines, index + 1, tableEndLine(lines, index + 1));
    }
  });

  return lines
    .filter((_, index) => !removedLines.has(index + 1))
    .map((line) => line.text)
    .join("\n");
}

function mergeFeaturesIntoBlock(block: string, existingToml: string): string {
  const preservedFeatureLines = (
    readTableBody(scanTomlLines(existingToml), FEATURES_TABLE) ?? []
  ).filter((line) => line.trim().length > 0 && !/^\s*runtime_metrics\s*=/.test(line));
  if (preservedFeatureLines.length === 0) return block;

  const replacement = ["[features]", ...preservedFeatureLines, "runtime_metrics = true"].join("\n");
  return block.replace("[features]\nruntime_metrics = true", () => replacement);
}

export function mergeTomlBlocks(existingToml: string, block: string): string {
  const mergedBlock = mergeFeaturesIntoBlock(block, existingToml);

  const trimmed = removeManagedSections(existingToml).trimEnd();
  return (trimmed ? trimmed + "\n\n" : "") + mergedBlock;
}

export interface CodexTomlWriteResult {
  configPath: string;
  backupPath: string | null;
}

export async function writeCodexToml(
  block: string,
  configPath?: string,
): Promise<CodexTomlWriteResult> {
  const targetPath = getCodexConfigPath(configPath);
  const targetDir = dirname(targetPath);

  await mkdir(targetDir, { recursive: true, mode: CONFIG_DIR_MODE });

  let existing = "";
  if (existsSync(targetPath)) {
    existing = await readFile(targetPath, "utf-8");
    await chmod(targetPath, CONFIG_FILE_MODE);
  }

  const backupPath = await backupConfigFile(targetPath, CONFIG_FILE_MODE);

  const merged = mergeTomlBlocks(existing, block);
  await writeFile(targetPath, merged, { encoding: "utf-8", mode: CONFIG_FILE_MODE });
  await chmod(targetPath, CONFIG_FILE_MODE);
  return { configPath: targetPath, backupPath };
}

const SOURCE_GUARD = [
  "# Managed by Revenium. Read by `revenium-codex`, never by your shell.",
  "# Sourcing this file is a no-op: nothing here is exported into your environment.",
  "return 0 2>/dev/null",
];

export function generateEnvContent(config: CodexOtelConfig): string {
  const lines: string[] = [...SOURCE_GUARD];

  if (config.logToolDetails === false) {
    lines.push(`${CODEX_ENV_KEYS.REVENIUM_API_KEY}=${escapeShellValue(config.apiKey)}`);
    lines.push(
      `${CODEX_ENV_KEYS.REVENIUM_ENDPOINT}=${escapeShellValue(resolveBaseEndpoint(config))}`,
    );
  }

  if (config.email) {
    lines.push(`${CODEX_ENV_KEYS.SUBSCRIBER_EMAIL}=${escapeShellValue(config.email)}`);
  }
  if (config.organizationName) {
    lines.push(`${CODEX_ENV_KEYS.ORGANIZATION_NAME}=${escapeShellValue(config.organizationName)}`);
  }
  if (config.productName) {
    lines.push(`${CODEX_ENV_KEYS.PRODUCT_NAME}=${escapeShellValue(config.productName)}`);
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeReveniumEnv(
  config: CodexOtelConfig,
  configPathOverride?: string,
): Promise<string> {
  const envPath = getReveniumEnvPath(configPathOverride);
  await mkdir(dirname(envPath), { recursive: true, mode: CONFIG_DIR_MODE });
  if (existsSync(envPath)) {
    await chmod(envPath, CONFIG_FILE_MODE);
  }
  await writeFile(envPath, generateEnvContent(config), {
    encoding: "utf-8",
    mode: CONFIG_FILE_MODE,
  });
  await chmod(envPath, CONFIG_FILE_MODE);
  return envPath;
}
