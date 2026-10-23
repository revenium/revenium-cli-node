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
import { ENV_VARS } from "../constants.js";
import { REVENIUM_ENV_FILE, DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { getFixedClaudeHomeDir } from "./claude-config-dir.js";
import { getConfigPath as getCursorConfigPath } from "../../cursor/config/loader.js";

export interface ClaudeCodeConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  extraUsageEnabled?: boolean;
  organizationName?: string;
  productName?: string;

  teamId?: string;

  // Claude Code only emits skill names on skill_activated when OTEL_LOG_TOOL_DETAILS=1.
  // Undefined means the config file predates the flag; false is a deliberate opt-out.
  logToolDetails?: boolean;

  // Explicit override for the management-plane API base (session attribution, etc.).
  // Undefined means "use the default" — resolved at call time via getManagementEndpoint().
  managementEndpoint?: string;
}

export function getConfigPath(): string {
  const override = process.env.REVENIUM_CONFIG_PATH;
  if (override && override.trim()) {
    return override.trim();
  }
  const claudePath = join(getFixedClaudeHomeDir(), REVENIUM_ENV_FILE);
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

export function isCursorProvidedConfig(): boolean {
  return getConfigPath() === getCursorConfigPath();
}

function extractApiKeyFromHeaders(headers: string): string | undefined {
  const match = headers.match(/x-api-key=\s*((?:hak_|rev_)[^\s"]+)/);
  return match?.[1];
}

function resolveApiKey(env: Record<string, string>): string | undefined {
  // Within a single file the OTLP header key wins: it is the form the Claude Code exporter
  // actually sends, so a file carrying both must stay consistent with what is metered.
  const fromHeaders = extractApiKeyFromHeaders(env[ENV_VARS.OTLP_HEADERS] || "");
  if (fromHeaders) {
    return fromHeaders;
  }
  return env[ENV_VARS.CURSOR_API_KEY]?.trim() || undefined;
}

function resolveEndpoint(env: Record<string, string>): string {
  return extractBaseEndpoint(
    env[ENV_VARS.OTLP_ENDPOINT] || env[ENV_VARS.CURSOR_ENDPOINT] || DEFAULT_REVENIUM_URL,
  );
}

export async function loadConfig(): Promise<ClaudeCodeConfig | null> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const env = parseEnvContent(content);

    const apiKey = resolveApiKey(env);

    if (!apiKey) {
      return null;
    }

    const extraUsageEnabledRaw = env[ENV_VARS.EXTRA_USAGE_ENABLED];
    const extraUsageEnabled =
      extraUsageEnabledRaw === "1" ? true : extraUsageEnabledRaw === "0" ? false : undefined;

    const logToolDetailsRaw = env[ENV_VARS.LOG_TOOL_DETAILS];
    const logToolDetails =
      logToolDetailsRaw === "1" ? true : logToolDetailsRaw === "0" ? false : undefined;

    const resourceAttrsStr = env[ENV_VARS.RESOURCE_ATTRIBUTES] || "";
    const resourceAttrs = parseOtelResourceAttributes(resourceAttrsStr);

    const organizationName =
      resourceAttrs["organization.name"] ||
      resourceAttrs["organization.id"] ||
      env[ENV_VARS.ORGANIZATION_ID] ||
      env[ENV_VARS.CURSOR_ORGANIZATION_NAME];

    const productName =
      resourceAttrs["product.name"] ||
      resourceAttrs["product.id"] ||
      env[ENV_VARS.PRODUCT_ID] ||
      env[ENV_VARS.CURSOR_PRODUCT_NAME];

    return {
      apiKey,
      endpoint: resolveEndpoint(env),
      email: env[ENV_VARS.SUBSCRIBER_EMAIL],
      extraUsageEnabled,
      organizationName,
      productName,
      teamId: env[ENV_VARS.TEAM_ID] || undefined,
      logToolDetails,
      // Process env wins over the config file: the constant is documented as a shell-level
      // override (PRODUCT-2674 bug 2).
      managementEndpoint:
        process.env[ENV_VARS.MGMT_ENDPOINT]?.trim() || env[ENV_VARS.MGMT_ENDPOINT] || undefined,
    };
  } catch {
    return null;
  }
}

export { getFullOtlpEndpoint, getManagementEndpoint };
