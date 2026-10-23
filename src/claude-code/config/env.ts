import { ENV_VARS } from "../constants.js";
import { MIDDLEWARE_SOURCE_KEY, MIDDLEWARE_SOURCE_LIVE } from "../../_core/constants.js";
import { escapeResourceAttributeValue } from "../../_core/shell/escaping.js";
import { buildResourceAttributes } from "../../_core/config/resource-attributes.js";
import { getFullOtlpEndpoint } from "../../_core/config/loader.js";
import type { ClaudeCodeConfig } from "./loader.js";

export const TELEMETRY_ENV_KEYS: string[] = [
  ENV_VARS.TELEMETRY_ENABLED,
  ENV_VARS.OTLP_ENDPOINT,
  ENV_VARS.OTLP_HEADERS,
  ENV_VARS.OTLP_PROTOCOL,
  ENV_VARS.LOGS_EXPORTER,
  ENV_VARS.LOG_TOOL_DETAILS,
  ENV_VARS.LOG_TOOL_CONTENT,
  ENV_VARS.RESOURCE_ATTRIBUTES,
  ENV_VARS.SUBSCRIBER_EMAIL,
  ENV_VARS.EXTRA_USAGE_ENABLED,
  ENV_VARS.TEAM_ID,
  ENV_VARS.MGMT_ENDPOINT,
];

function buildClaudeCodeResourceAttributes(config: ClaudeCodeConfig): string {
  const source = `${MIDDLEWARE_SOURCE_KEY}=${escapeResourceAttributeValue(MIDDLEWARE_SOURCE_LIVE)}`;
  const attribution = buildResourceAttributes(config);

  return attribution ? `${source},${attribution}` : source;
}

export function buildClaudeCodeEnv(config: ClaudeCodeConfig): Record<string, string> {
  const env: Record<string, string> = {
    [ENV_VARS.TELEMETRY_ENABLED]: "1",
    [ENV_VARS.OTLP_ENDPOINT]: getFullOtlpEndpoint(config.endpoint),
    [ENV_VARS.OTLP_HEADERS]: `x-api-key=${config.apiKey}`,
    [ENV_VARS.OTLP_PROTOCOL]: "http/json",
    [ENV_VARS.LOGS_EXPORTER]: "otlp",
    [ENV_VARS.LOG_TOOL_DETAILS]: config.logToolDetails === false ? "0" : "1",
    [ENV_VARS.LOG_TOOL_CONTENT]: "0",
    [ENV_VARS.RESOURCE_ATTRIBUTES]: buildClaudeCodeResourceAttributes(config),
  };

  if (config.email) {
    env[ENV_VARS.SUBSCRIBER_EMAIL] = config.email;
  }
  if (config.extraUsageEnabled !== undefined) {
    env[ENV_VARS.EXTRA_USAGE_ENABLED] = config.extraUsageEnabled ? "1" : "0";
  }
  if (config.teamId) {
    env[ENV_VARS.TEAM_ID] = config.teamId;
  }
  if (config.managementEndpoint) {
    env[ENV_VARS.MGMT_ENDPOINT] = config.managementEndpoint;
  }

  return env;
}
