import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  parseEnvContent,
  extractBaseEndpoint,
  getFullOtlpEndpoint,
} from "../../_core/config/loader.js";
import { GEMINI_CONFIG_DIR, ENV_VARS } from "../constants.js";
import { REVENIUM_ENV_FILE, REVENIUM_API_KEY_ATTR } from "../../_core/constants.js";
import { detectShell } from "../../_core/shell/detector.js";

export interface GeminiCliConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  costMultiplier?: number;
}

export function getConfigPath(): string {
  return join(homedir(), GEMINI_CONFIG_DIR, REVENIUM_ENV_FILE);
}

function getShellSpecificConfigPath(): string {
  const shellType = detectShell();
  if (shellType === "fish") {
    return join(homedir(), GEMINI_CONFIG_DIR, "revenium.fish");
  }
  return getConfigPath();
}

export function configExists(): boolean {
  const envPath = getConfigPath();
  const shellPath = getShellSpecificConfigPath();
  return existsSync(envPath) || existsSync(shellPath);
}

function extractApiKeyFromResourceAttrs(attrs: string): string | undefined {
  const pairs = attrs.split(",");
  for (const pair of pairs) {
    const equalsIndex = pair.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = pair.substring(0, equalsIndex).trim();
    const value = pair.substring(equalsIndex + 1).trim();

    if (key === REVENIUM_API_KEY_ATTR && value) {
      return value;
    }
  }
  return undefined;
}

export async function loadConfig(): Promise<GeminiCliConfig | null> {
  const shellPath = getShellSpecificConfigPath();
  const envPath = getConfigPath();
  const shellType = detectShell();

  let configPath = envPath;
  let isFish = false;

  if (existsSync(shellPath)) {
    configPath = shellPath;
    isFish = shellType === "fish";
  } else if (!existsSync(envPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const env = parseEnvContent(content, isFish);

    const fullEndpoint = env[ENV_VARS.TELEMETRY_OTLP_ENDPOINT] || "";
    const resourceAttrs = env[ENV_VARS.RESOURCE_ATTRIBUTES] || "";
    const apiKey = extractApiKeyFromResourceAttrs(resourceAttrs);

    if (!apiKey) return null;

    const costMultiplierStr = env[ENV_VARS.COST_MULTIPLIER];
    let costMultiplier: number | undefined = undefined;
    if (costMultiplierStr) {
      const parsed = parseFloat(costMultiplierStr);
      if (isFinite(parsed) && parsed > 0) {
        costMultiplier = parsed;
      }
    }

    return {
      apiKey,
      endpoint: extractBaseEndpoint(fullEndpoint),
      email: env[ENV_VARS.SUBSCRIBER_EMAIL],
      organizationName: env[ENV_VARS.ORGANIZATION_NAME],
      productName: env[ENV_VARS.PRODUCT_NAME],
      costMultiplier,
    };
  } catch {
    return null;
  }
}

export function isEnvLoaded(): boolean {
  return (
    process.env[ENV_VARS.TELEMETRY_ENABLED] === "true" &&
    !!process.env[ENV_VARS.TELEMETRY_OTLP_ENDPOINT] &&
    !!process.env[ENV_VARS.RESOURCE_ATTRIBUTES]
  );
}

export { getFullOtlpEndpoint };
