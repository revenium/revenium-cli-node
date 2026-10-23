import { CODEX_ENV_KEYS } from "../constants.js";
import {
  buildResourceAttributes,
  type ResourceAttributeValues,
} from "../../_core/config/resource-attributes.js";
import { readReveniumEnv, reveniumEnvExists } from "./loader.js";

export async function loadCodexAttribution(
  configPath?: string,
): Promise<ResourceAttributeValues | null> {
  if (!reveniumEnvExists(configPath)) return null;

  const env = await readReveniumEnv(configPath);

  return {
    organizationName: env[CODEX_ENV_KEYS.ORGANIZATION_NAME],
    productName: env[CODEX_ENV_KEYS.PRODUCT_NAME],
  };
}

export function buildCodexEnv(attribution: ResourceAttributeValues): Record<string, string> {
  const resourceAttributes = buildResourceAttributes(attribution);
  if (!resourceAttributes) return {};

  return { [CODEX_ENV_KEYS.RESOURCE_ATTRIBUTES]: resourceAttributes };
}
