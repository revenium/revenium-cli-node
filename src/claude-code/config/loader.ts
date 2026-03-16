import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  parseEnvContent,
  parseOtelResourceAttributes,
  extractBaseEndpoint,
  getFullOtlpEndpoint,
} from "../../_core/config/loader.js";
import { CLAUDE_CONFIG_DIR, ENV_VARS } from "../constants.js";
import type { SubscriptionTier } from "../constants.js";
import { REVENIUM_ENV_FILE } from "../../_core/constants.js";

export interface ClaudeCodeConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  subscriptionTier?: SubscriptionTier;
  extraUsageEnabled?: boolean;
  organizationName?: string;
  organizationId?: string;
  productName?: string;
  productId?: string;
}

export function getConfigPath(): string {
  return join(homedir(), CLAUDE_CONFIG_DIR, REVENIUM_ENV_FILE);
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

function extractApiKeyFromHeaders(headers: string): string | undefined {
  const match = headers.match(/x-api-key=\s*(hak_[^\s"]+)/);
  return match?.[1];
}

export async function loadConfig(): Promise<ClaudeCodeConfig | null> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const env = parseEnvContent(content);

    const fullEndpoint = env[ENV_VARS.OTLP_ENDPOINT] || "";
    const headers = env[ENV_VARS.OTLP_HEADERS] || "";
    const apiKey = extractApiKeyFromHeaders(headers);

    if (!apiKey) {
      return null;
    }

    const subscriptionTier = (env[ENV_VARS.SUBSCRIPTION_TIER] || env[ENV_VARS.SUBSCRIPTION]) as
      | SubscriptionTier
      | undefined;

    const extraUsageEnabledRaw = env[ENV_VARS.EXTRA_USAGE_ENABLED];
    const extraUsageEnabled =
      extraUsageEnabledRaw === "1" ? true : extraUsageEnabledRaw === "0" ? false : undefined;

    const resourceAttrsStr = env["OTEL_RESOURCE_ATTRIBUTES"] || "";
    const resourceAttrs = parseOtelResourceAttributes(resourceAttrsStr);

    const organizationName =
      resourceAttrs["organization.name"] ||
      resourceAttrs["organization.id"] ||
      env[ENV_VARS.ORGANIZATION_ID];

    const productName =
      resourceAttrs["product.name"] || resourceAttrs["product.id"] || env[ENV_VARS.PRODUCT_ID];

    return {
      apiKey,
      endpoint: extractBaseEndpoint(fullEndpoint),
      email: env[ENV_VARS.SUBSCRIBER_EMAIL],
      subscriptionTier,
      extraUsageEnabled,
      organizationName,
      organizationId: organizationName,
      productName,
      productId: productName,
    };
  } catch {
    return null;
  }
}

export function isEnvLoaded(): boolean {
  return process.env[ENV_VARS.TELEMETRY_ENABLED] === "1" && !!process.env[ENV_VARS.OTLP_ENDPOINT];
}

export { getFullOtlpEndpoint };
