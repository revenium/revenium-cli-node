import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  parseEnvContent,
  parseOtelResourceAttributes,
  extractBaseEndpoint,
  getFullOtlpEndpoint,
  getManagementEndpoint,
} from "../../_core/config/loader.js";
import { CLAUDE_HOME_DIR_NAME, ENV_VARS } from "../constants.js";
import { REVENIUM_ENV_FILE } from "../../_core/constants.js";
import { getConfigPath as getCursorConfigPath } from "../../cursor/config/loader.js";

export interface ClaudeCodeConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  extraUsageEnabled?: boolean;
  organizationName?: string;
  productName?: string;

  teamId?: string;

  // Explicit override for the management-plane API base (session attribution, etc.).
  // Undefined means "use the default" — resolved at call time via getManagementEndpoint().
  managementEndpoint?: string;
}

export function getConfigPath(): string {
  const override = process.env.REVENIUM_CONFIG_PATH;
  if (override && override.trim()) {
    return override.trim();
  }
  const claudePath = join(homedir(), CLAUDE_HOME_DIR_NAME, REVENIUM_ENV_FILE);
  if (existsSync(claudePath)) {
    return claudePath;
  }
  // Cursor-only machines have no ~/.claude/revenium.env, so fall back to the config Cursor's
  // own setup wrote.
  const cursorPath = getCursorConfigPath();
  if (existsSync(cursorPath)) {
    return cursorPath;
  }
  return claudePath;
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

function extractApiKeyFromHeaders(headers: string): string | undefined {
  const match = headers.match(/x-api-key=\s*((?:hak_|rev_)[^\s"]+)/);
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
      extraUsageEnabled,
      organizationName,
      productName,
      teamId: env[ENV_VARS.TEAM_ID] || undefined,
      // Process env wins over the config file: the constant is documented as a shell-level
      // override and config/writer.ts emits it as an export (PRODUCT-2674 bug 2).
      managementEndpoint:
        process.env[ENV_VARS.MGMT_ENDPOINT]?.trim() || env[ENV_VARS.MGMT_ENDPOINT] || undefined,
    };
  } catch {
    return null;
  }
}

export function isEnvLoaded(): boolean {
  return process.env[ENV_VARS.TELEMETRY_ENABLED] === "1" && !!process.env[ENV_VARS.OTLP_ENDPOINT];
}

export { getFullOtlpEndpoint, getManagementEndpoint };
