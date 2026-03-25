import { join } from "node:path";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { CONFIG_FILE_MODE } from "../../_core/constants.js";
import { DIR_MODE, ENV_KEYS, DEFAULT_SYNC_INTERVAL_MS } from "../constants.js";
import { escapeFishValue } from "../../_core/shell/escaping.js";
import type { CursorConfig } from "../types.js";
import { getConfigDir } from "./loader.js";

function generateEnvContent(config: CursorConfig): string {
  const lines: string[] = [
    `${ENV_KEYS.CURSOR_API_KEY}=${config.cursorApiKey}`,
    `${ENV_KEYS.REVENIUM_API_KEY}=${config.reveniumApiKey}`,
    `${ENV_KEYS.REVENIUM_ENDPOINT}=${config.reveniumEndpoint}`,
  ];

  if (config.email) {
    lines.push(`${ENV_KEYS.SUBSCRIBER_EMAIL}=${config.email}`);
  }

  if (config.organizationName) {
    lines.push(`${ENV_KEYS.ORGANIZATION_NAME}=${config.organizationName}`);
  }

  if (config.productName) {
    lines.push(`${ENV_KEYS.PRODUCT_NAME}=${config.productName}`);
  }

  if (config.syncIntervalMs !== DEFAULT_SYNC_INTERVAL_MS) {
    lines.push(`${ENV_KEYS.SYNC_INTERVAL_MS}=${config.syncIntervalMs}`);
  }

  if (config.subscriptionTier) {
    lines.push(`${ENV_KEYS.SUBSCRIPTION_TIER}=${config.subscriptionTier}`);
  }

  lines.push("");
  return lines.join("\n");
}

function generateFishContent(config: CursorConfig): string {
  const lines: string[] = [
    `set -gx ${ENV_KEYS.CURSOR_API_KEY} ${escapeFishValue(config.cursorApiKey)}`,
    `set -gx ${ENV_KEYS.REVENIUM_API_KEY} ${escapeFishValue(config.reveniumApiKey)}`,
    `set -gx ${ENV_KEYS.REVENIUM_ENDPOINT} ${escapeFishValue(config.reveniumEndpoint)}`,
  ];

  if (config.email) {
    lines.push(`set -gx ${ENV_KEYS.SUBSCRIBER_EMAIL} ${escapeFishValue(config.email)}`);
  }

  if (config.organizationName) {
    lines.push(`set -gx ${ENV_KEYS.ORGANIZATION_NAME} ${escapeFishValue(config.organizationName)}`);
  }

  if (config.productName) {
    lines.push(`set -gx ${ENV_KEYS.PRODUCT_NAME} ${escapeFishValue(config.productName)}`);
  }

  if (config.syncIntervalMs !== DEFAULT_SYNC_INTERVAL_MS) {
    lines.push(`set -gx ${ENV_KEYS.SYNC_INTERVAL_MS} ${config.syncIntervalMs}`);
  }

  if (config.subscriptionTier) {
    lines.push(`set -gx ${ENV_KEYS.SUBSCRIPTION_TIER} ${escapeFishValue(config.subscriptionTier)}`);
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeConfig(
  config: CursorConfig,
): Promise<{ envPath: string; fishPath: string }> {
  const configDir = getConfigDir();
  const configPath = join(configDir, "revenium.env");
  const fishConfigPath = join(configDir, "revenium.fish");

  await mkdir(configDir, { recursive: true, mode: DIR_MODE });

  const content = generateEnvContent(config);
  await writeFile(configPath, content, { encoding: "utf-8" });
  await chmod(configPath, CONFIG_FILE_MODE);

  const fishContent = generateFishContent(config);
  await writeFile(fishConfigPath, fishContent, { encoding: "utf-8" });
  await chmod(fishConfigPath, CONFIG_FILE_MODE);

  return { envPath: configPath, fishPath: fishConfigPath };
}
