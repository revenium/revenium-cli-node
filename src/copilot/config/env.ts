import { ENV_KEYS, DEFAULT_SYNC_INTERVAL_MS } from "../constants.js";
import { buildOptionalEnv } from "../../_core/config/optional-env.js";
import type { CopilotConfig } from "../types.js";

export function buildCopilotEnv(config: CopilotConfig): Record<string, string> {
  const env: Record<string, string> = {
    [ENV_KEYS.REVENIUM_API_KEY]: config.reveniumApiKey,
    [ENV_KEYS.REVENIUM_ENDPOINT]: config.reveniumEndpoint,
  };

  if (config.githubToken) {
    env[ENV_KEYS.GITHUB_TOKEN] = config.githubToken;
  }
  if (config.githubOrg) {
    env[ENV_KEYS.GITHUB_ORG] = config.githubOrg;
  }

  return { ...env, ...buildOptionalEnv(config, ENV_KEYS, DEFAULT_SYNC_INTERVAL_MS) };
}
