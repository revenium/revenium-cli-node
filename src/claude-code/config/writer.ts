import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { CLAUDE_CONFIG_DIR, ENV_VARS } from "../constants.js";
import { CONFIG_FILE_MODE, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import {
  escapeDoubleQuotedShellValue,
  escapeFishValue,
  escapeResourceAttributeValue,
} from "../../_core/shell/escaping.js";
import { getFullOtlpEndpoint } from "./loader.js";
import type { ClaudeCodeConfig } from "./loader.js";

function getClaudeConfigDir(): string {
  return join(homedir(), CLAUDE_CONFIG_DIR);
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
  ];

  if (config.email) {
    lines.push("");
    lines.push(`export ${ENV_VARS.SUBSCRIBER_EMAIL}=${escapeDoubleQuotedShellValue(config.email)}`);
  }

  if (config.subscriptionTier) {
    lines.push("");
    lines.push(
      `export ${ENV_VARS.SUBSCRIPTION}=${escapeDoubleQuotedShellValue(config.subscriptionTier)}`,
    );

    lines.push("");
    lines.push(
      `export ${ENV_VARS.SUBSCRIPTION_TIER}=${escapeDoubleQuotedShellValue(config.subscriptionTier)}`,
    );
  }

  if (config.extraUsageEnabled !== undefined) {
    lines.push("");
    lines.push(`export ${ENV_VARS.EXTRA_USAGE_ENABLED}=${config.extraUsageEnabled ? 1 : 0}`);
  }

  // Write OTEL_RESOURCE_ATTRIBUTES when email or tier is present
  if (config.email || config.subscriptionTier) {
    const resourceAttrs: string[] = [];

    if (config.subscriptionTier) {
      resourceAttrs.push(
        `CLAUDE_CODE_SUBSCRIPTION_TIER=${escapeResourceAttributeValue(config.subscriptionTier)}`,
      );
    }

    if (config.email) {
      resourceAttrs.push(`user.email=${escapeResourceAttributeValue(config.email)}`);
    }

    const organizationValue = config.organizationName || config.organizationId;
    if (organizationValue) {
      resourceAttrs.push(`organization.name=${escapeResourceAttributeValue(organizationValue)}`);
    }

    const productValue = config.productName || config.productId;
    if (productValue) {
      resourceAttrs.push(`product.name=${escapeResourceAttributeValue(productValue)}`);
    }

    if (resourceAttrs.length > 0) {
      lines.push("");
      lines.push(`export OTEL_RESOURCE_ATTRIBUTES="${resourceAttrs.join(",")}"`);
    }
  }

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
  ];

  if (config.email) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.SUBSCRIBER_EMAIL} ${escapeFishValue(config.email)}`);
  }

  if (config.subscriptionTier) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.SUBSCRIPTION} ${escapeFishValue(config.subscriptionTier)}`);

    lines.push("");
    lines.push(`set -gx ${ENV_VARS.SUBSCRIPTION_TIER} ${escapeFishValue(config.subscriptionTier)}`);
  }

  if (config.extraUsageEnabled !== undefined) {
    lines.push("");
    lines.push(`set -gx ${ENV_VARS.EXTRA_USAGE_ENABLED} ${config.extraUsageEnabled ? 1 : 0}`);
  }

  // Write OTEL_RESOURCE_ATTRIBUTES when email or tier is present
  if (config.email || config.subscriptionTier) {
    const resourceAttrs: string[] = [];

    if (config.subscriptionTier) {
      resourceAttrs.push(
        `CLAUDE_CODE_SUBSCRIPTION_TIER=${escapeResourceAttributeValue(config.subscriptionTier)}`,
      );
    }

    if (config.email) {
      resourceAttrs.push(`user.email=${escapeResourceAttributeValue(config.email)}`);
    }

    const organizationValue = config.organizationName || config.organizationId;
    if (organizationValue) {
      resourceAttrs.push(`organization.name=${escapeResourceAttributeValue(organizationValue)}`);
    }

    const productValue = config.productName || config.productId;
    if (productValue) {
      resourceAttrs.push(`product.name=${escapeResourceAttributeValue(productValue)}`);
    }

    if (resourceAttrs.length > 0) {
      lines.push("");
      lines.push(`set -gx OTEL_RESOURCE_ATTRIBUTES ${escapeFishValue(resourceAttrs.join(","))}`);
    }
  }

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
