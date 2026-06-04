import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CODEX_CONFIG_DIR } from "../constants.js";
import {
  CONFIG_FILE_MODE,
  DEFAULT_REVENIUM_URL,
  REVENIUM_ENV_FILE,
  REVENIUM_API_KEY_ATTR,
} from "../../_core/constants.js";
import { escapeShellValue, escapeResourceAttributeValue } from "../../_core/shell/escaping.js";
import { extractBaseEndpoint, getFullOtlpEndpoint } from "../../_core/config/loader.js";
import { getCodexConfigPath } from "./loader.js";

export interface CodexOtelConfig {
  apiKey: string;
  endpoint?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
}

function escapeTomlString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export function generateTomlBlock(config: CodexOtelConfig): string {
  const rawEndpoint = (config.endpoint ?? DEFAULT_REVENIUM_URL).replace(/\/+$/, "");
  const baseEndpoint = extractBaseEndpoint(rawEndpoint);
  // Always rebuild from the bare origin so any stored variant — `/v1/logs`,
  // `/meter/v2/otlp`, `/meter/v2/otlp/v1/logs`, or no path — normalises to the
  // canonical OTLP logs path.
  const logsEndpoint = `${getFullOtlpEndpoint(baseEndpoint)}/v1/logs`;

  const lines: string[] = [
    "[otel]",
    `exporter = { otlp-http = { endpoint = "${escapeTomlString(logsEndpoint)}", protocol = "json", headers = { "x-api-key" = "${escapeTomlString(config.apiKey)}" } } }`,
    `metrics_exporter = "none"`,
    "",
    "[features]",
    "runtime_metrics = true",
    "",
  ];

  return lines.join("\n");
}

function removeTomlSection(text: string, name: string): string {
  const sectionExact = `[${name}]`;
  const nestedPrefix = `[${name}.`;
  const lines = text.split("\n");
  const kept: string[] = [];
  let inMatchingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isSectionHeader = /^\[[^\]]+\]$/.test(trimmed);
    if (isSectionHeader) {
      inMatchingSection = trimmed === sectionExact || trimmed.startsWith(nestedPrefix);
      if (inMatchingSection) continue;
    }
    if (!inMatchingSection) kept.push(line);
  }

  return kept.join("\n");
}

function readTomlSection(text: string, name: string): string[] {
  const lines = text.split("\n");
  const sectionLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      inSection = line.trim() === `[${name}]`;
      continue;
    }
    if (inSection) sectionLines.push(line);
  }

  return sectionLines;
}

function removeFlatOtelKeys(text: string): string {
  return text.replace(/^otel\.[^\n]*(?:\n|$)/gm, "");
}

function mergeFeaturesIntoBlock(block: string, existingToml: string): string {
  const preservedFeatureLines = readTomlSection(existingToml, "features").filter(
    (line) => line.trim().length > 0 && !/^\s*runtime_metrics\s*=/.test(line),
  );
  if (preservedFeatureLines.length === 0) return block;

  const replacement = ["[features]", ...preservedFeatureLines, "runtime_metrics = true"].join("\n");
  return block.replace("[features]\nruntime_metrics = true", () => replacement);
}

export function mergeTomlBlocks(existingToml: string, block: string): string {
  let result = removeFlatOtelKeys(existingToml);
  const mergedBlock = mergeFeaturesIntoBlock(block, result);

  result = removeTomlSection(result, "otel");
  result = removeTomlSection(result, "features");

  const trimmed = result.trimEnd();
  return (trimmed ? trimmed + "\n\n" : "") + mergedBlock;
}

export async function writeCodexToml(block: string, configPath?: string): Promise<string> {
  const targetPath = getCodexConfigPath(configPath);
  const targetDir = dirname(targetPath);

  await mkdir(targetDir, { recursive: true });

  let existing = "";
  if (existsSync(targetPath)) {
    existing = await readFile(targetPath, "utf-8");
  }

  const merged = mergeTomlBlocks(existing, block);
  await writeFile(targetPath, merged, { encoding: "utf-8", mode: CONFIG_FILE_MODE });
  return targetPath;
}

export function getReveniumEnvPath(configPathOverride?: string): string {
  if (configPathOverride) {
    return join(dirname(configPathOverride), REVENIUM_ENV_FILE);
  }
  return join(homedir(), CODEX_CONFIG_DIR, REVENIUM_ENV_FILE);
}

function buildResourceAttrs(config: CodexOtelConfig): string[] {
  const attrs: string[] = [
    `${REVENIUM_API_KEY_ATTR}=${escapeResourceAttributeValue(config.apiKey)}`,
  ];
  if (config.email) {
    attrs.push(`user.email=${escapeResourceAttributeValue(config.email)}`);
  }
  if (config.organizationName) {
    attrs.push(`organization.name=${escapeResourceAttributeValue(config.organizationName)}`);
  }
  if (config.productName) {
    attrs.push(`product.name=${escapeResourceAttributeValue(config.productName)}`);
  }
  return attrs;
}

export function generateEnvContent(config: CodexOtelConfig): string {
  const resourceAttrs = buildResourceAttrs(config);
  const lines: string[] = [`export REVENIUM_API_KEY=${escapeShellValue(config.apiKey)}`];

  if (config.email) {
    lines.push(`export REVENIUM_SUBSCRIBER_EMAIL=${escapeShellValue(config.email)}`);
  }
  if (config.organizationName) {
    lines.push(`export REVENIUM_ORGANIZATION_NAME=${escapeShellValue(config.organizationName)}`);
  }
  if (config.productName) {
    lines.push(`export REVENIUM_PRODUCT_NAME=${escapeShellValue(config.productName)}`);
  }

  lines.push(`export OTEL_RESOURCE_ATTRIBUTES=${escapeShellValue(resourceAttrs.join(","))}`);
  lines.push("");
  return lines.join("\n");
}

export async function writeReveniumEnv(
  config: CodexOtelConfig,
  configPathOverride?: string,
): Promise<string> {
  const envPath = getReveniumEnvPath(configPathOverride);
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, generateEnvContent(config), {
    encoding: "utf-8",
    mode: CONFIG_FILE_MODE,
  });
  return envPath;
}
