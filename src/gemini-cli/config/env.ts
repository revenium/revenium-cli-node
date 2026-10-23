import { ENV_VARS } from "../constants.js";
import { buildResourceAttributes } from "../../_core/config/resource-attributes.js";
import { getFullOtlpEndpoint } from "../../_core/config/loader.js";
import type { GeminiCliConfig } from "./loader.js";

export function buildGeminiEnv(config: GeminiCliConfig): Record<string, string> {
  const env: Record<string, string> = {
    [ENV_VARS.TELEMETRY_ENABLED]: "true",
    [ENV_VARS.TELEMETRY_TARGET]: "local",
    [ENV_VARS.TELEMETRY_OTLP_ENDPOINT]: getFullOtlpEndpoint(config.endpoint),
    [ENV_VARS.TELEMETRY_OTLP_PROTOCOL]: "http",
    [ENV_VARS.TELEMETRY_LOG_PROMPTS]: "false",
    [ENV_VARS.OTLP_HEADERS]: `x-api-key=${config.apiKey}`,
    [ENV_VARS.RESOURCE_ATTRIBUTES]: buildResourceAttributes(config),
  };

  if (config.email) {
    env[ENV_VARS.SUBSCRIBER_EMAIL] = config.email;
  }
  if (config.organizationName) {
    env[ENV_VARS.ORGANIZATION_NAME] = config.organizationName;
  }
  if (config.productName) {
    env[ENV_VARS.PRODUCT_NAME] = config.productName;
  }

  return env;
}
