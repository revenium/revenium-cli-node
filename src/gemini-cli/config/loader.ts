import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseEnvContent, extractBaseEndpoint } from "../../_core/config/loader.js";
import { GEMINI_CONFIG_DIR, ENV_VARS } from "../constants.js";
import { REVENIUM_ENV_FILE, REVENIUM_API_KEY_ATTR } from "../../_core/constants.js";

export interface GeminiCliConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  organizationName?: string;
  productName?: string;
}

export interface LoadedGeminiCliConfig extends GeminiCliConfig {
  legacy: boolean;
}

export function getConfigPath(): string {
  return join(homedir(), GEMINI_CONFIG_DIR, REVENIUM_ENV_FILE);
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

function extractPairValue(pairs: string, name: string): string | undefined {
  for (const pair of pairs.split(",")) {
    const equalsIndex = pair.indexOf("=");
    if (equalsIndex === -1) continue;

    if (pair.substring(0, equalsIndex).trim() !== name) continue;

    const value = pair.substring(equalsIndex + 1).trim();
    if (value) return value;
  }
  return undefined;
}

export async function loadConfig(): Promise<LoadedGeminiCliConfig | null> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const env = parseEnvContent(await readFile(configPath, "utf-8"));

    const headerApiKey = extractPairValue(env[ENV_VARS.OTLP_HEADERS] || "", "x-api-key");
    const legacyApiKey = extractPairValue(
      env[ENV_VARS.RESOURCE_ATTRIBUTES] || "",
      REVENIUM_API_KEY_ATTR,
    );
    const apiKey = headerApiKey || legacyApiKey;

    if (!apiKey) return null;

    return {
      apiKey,
      endpoint: extractBaseEndpoint(env[ENV_VARS.TELEMETRY_OTLP_ENDPOINT] || ""),
      email: env[ENV_VARS.SUBSCRIBER_EMAIL],
      organizationName: env[ENV_VARS.ORGANIZATION_NAME],
      productName: env[ENV_VARS.PRODUCT_NAME],
      legacy: !headerApiKey,
    };
  } catch {
    return null;
  }
}
