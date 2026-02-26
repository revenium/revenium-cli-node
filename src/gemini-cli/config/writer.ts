import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { GEMINI_CONFIG_DIR, ENV_VARS, DEFAULT_COST_MULTIPLIER } from "../constants.js";
import {
  CONFIG_FILE_MODE,
  REVENIUM_ENV_FILE,
  REVENIUM_API_KEY_ATTR,
} from "../../_core/constants.js";
import {
  escapeShellValue,
  escapeFishValue,
  escapeResourceAttributeValue,
} from "../../_core/shell/escaping.js";
import { getFullOtlpEndpoint } from "./loader.js";
import type { GeminiCliConfig } from "./loader.js";

function getGeminiConfigDir(): string {
  return join(homedir(), GEMINI_CONFIG_DIR);
}

function buildResourceAttrs(config: GeminiCliConfig): string[] {
  const attrs: string[] = [`${REVENIUM_API_KEY_ATTR}=${config.apiKey}`];
  const costMultiplier = config.costMultiplier ?? DEFAULT_COST_MULTIPLIER;
  attrs.push(`cost_multiplier=${costMultiplier}`);

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

function generateEnvContent(config: GeminiCliConfig): string {
  const fullEndpoint = getFullOtlpEndpoint(config.endpoint);
  const resourceAttrs = buildResourceAttrs(config);

  const lines: string[] = [
    `export ${ENV_VARS.TELEMETRY_ENABLED}=true`,
    "",
    `export ${ENV_VARS.TELEMETRY_TARGET}=local`,
    "",
    `export ${ENV_VARS.TELEMETRY_OTLP_ENDPOINT}=${escapeShellValue(fullEndpoint)}`,
    "",
    `export ${ENV_VARS.TELEMETRY_OTLP_PROTOCOL}=http`,
    "",
    `export ${ENV_VARS.TELEMETRY_LOG_PROMPTS}=true`,
  ];

  if (config.email) {
    lines.push("");
    lines.push(`export ${ENV_VARS.SUBSCRIBER_EMAIL}=${escapeShellValue(config.email)}`);
  }

  if (config.organizationName) {
    lines.push("");
    lines.push(`export ${ENV_VARS.ORGANIZATION_NAME}=${escapeShellValue(config.organizationName)}`);
  }

  if (config.productName) {
    lines.push("");
    lines.push(`export ${ENV_VARS.PRODUCT_NAME}=${escapeShellValue(config.productName)}`);
  }

  if (config.costMultiplier !== undefined && config.costMultiplier !== DEFAULT_COST_MULTIPLIER) {
    lines.push("");
    lines.push(
      `export ${ENV_VARS.COST_MULTIPLIER}=${escapeShellValue(config.costMultiplier.toString())}`,
    );
  }

  lines.push("");
  lines.push(`export ${ENV_VARS.RESOURCE_ATTRIBUTES}=${escapeShellValue(resourceAttrs.join(","))}`);

  lines.push("");
  return lines.join("\n");
}

function generateFishContent(config: GeminiCliConfig): string {
  const fullEndpoint = getFullOtlpEndpoint(config.endpoint);
  const resourceAttrs = buildResourceAttrs(config);

  const lines: string[] = [
    `set -gx ${ENV_VARS.TELEMETRY_ENABLED} true`,
    "",
    `set -gx ${ENV_VARS.TELEMETRY_TARGET} local`,
    "",
    `set -gx ${ENV_VARS.TELEMETRY_OTLP_ENDPOINT} ${escapeFishValue(fullEndpoint)}`,
    "",
    `set -gx ${ENV_VARS.TELEMETRY_OTLP_PROTOCOL} http`,
    "",
    `set -gx ${ENV_VARS.TELEMETRY_LOG_PROMPTS} true`,
  ];

  if (config.email) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.SUBSCRIBER_EMAIL} ${escapeFishValue(config.email)}`);
  }

  if (config.organizationName) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.ORGANIZATION_NAME} ${escapeFishValue(config.organizationName)}`);
  }

  if (config.productName) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.PRODUCT_NAME} ${escapeFishValue(config.productName)}`);
  }

  if (config.costMultiplier !== undefined && config.costMultiplier !== DEFAULT_COST_MULTIPLIER) {
    lines.push("");
    lines.push(
      `set -gx ${ENV_VARS.COST_MULTIPLIER} ${escapeFishValue(config.costMultiplier.toString())}`,
    );
  }

  lines.push("");
  lines.push(`set -gx ${ENV_VARS.RESOURCE_ATTRIBUTES} ${escapeFishValue(resourceAttrs.join(","))}`);

  lines.push("");
  return lines.join("\n");
}

export async function writeConfig(
  config: GeminiCliConfig,
): Promise<{ envPath: string; fishPath: string }> {
  const configDir = getGeminiConfigDir();
  const configPath = join(configDir, REVENIUM_ENV_FILE);
  const fishConfigPath = join(configDir, "revenium.fish");

  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const content = generateEnvContent(config);
  await writeFile(configPath, content, { encoding: "utf-8" });
  await chmod(configPath, CONFIG_FILE_MODE);

  const fishContent = generateFishContent(config);
  await writeFile(fishConfigPath, fishContent, { encoding: "utf-8" });
  await chmod(fishConfigPath, CONFIG_FILE_MODE);

  return { envPath: configPath, fishPath: fishConfigPath };
}

export function getConfigFilePath(): string {
  return join(getGeminiConfigDir(), REVENIUM_ENV_FILE);
}
