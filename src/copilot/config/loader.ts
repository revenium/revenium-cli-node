import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  COPILOT_CONFIG_DIR,
  REVENIUM_CONFIG_DIR,
  ENV_KEYS,
  DEFAULT_SYNC_INTERVAL_MS,
} from "../constants.js";
import { REVENIUM_ENV_FILE, DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { parseEnvContent } from "../../_core/config/loader.js";
import type { CopilotConfig } from "../types.js";

export function getConfigDir(): string {
  return join(homedir(), COPILOT_CONFIG_DIR, REVENIUM_CONFIG_DIR);
}

export function getConfigPath(): string {
  return join(getConfigDir(), REVENIUM_ENV_FILE);
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export async function loadConfig(): Promise<CopilotConfig | null> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const env = parseEnvContent(content);

    const githubToken = env[ENV_KEYS.GITHUB_TOKEN];
    const githubOrg = env[ENV_KEYS.GITHUB_ORG];
    const reveniumApiKey = env[ENV_KEYS.REVENIUM_API_KEY];

    if (!githubToken || !githubOrg || !reveniumApiKey) {
      return null;
    }

    const syncIntervalStr = env[ENV_KEYS.SYNC_INTERVAL_MS];
    let syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
    if (syncIntervalStr) {
      const parsed = parseInt(syncIntervalStr, 10);
      if (isFinite(parsed) && parsed > 0) {
        syncIntervalMs = parsed;
      }
    }

    return {
      githubToken,
      githubOrg,
      reveniumApiKey,
      reveniumEndpoint: env[ENV_KEYS.REVENIUM_ENDPOINT] || DEFAULT_REVENIUM_URL,
      email: env[ENV_KEYS.SUBSCRIBER_EMAIL] || undefined,
      organizationName: env[ENV_KEYS.ORGANIZATION_NAME] || undefined,
      productName: env[ENV_KEYS.PRODUCT_NAME] || undefined,
      syncIntervalMs,
      subscriptionTier:
        (env[ENV_KEYS.SUBSCRIPTION_TIER] as CopilotConfig["subscriptionTier"]) || undefined,
    };
  } catch {
    return null;
  }
}
