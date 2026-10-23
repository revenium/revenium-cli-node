export interface OptionalEnvKeys {
  SUBSCRIBER_EMAIL: string;
  ORGANIZATION_NAME: string;
  PRODUCT_NAME: string;
  SYNC_INTERVAL_MS: string;
  SUBSCRIPTION_TIER: string;
}

export interface OptionalEnvConfig {
  email?: string;
  organizationName?: string;
  productName?: string;
  syncIntervalMs: number;
  subscriptionTier?: string;
}

export function buildOptionalEnv(
  config: OptionalEnvConfig,
  keys: OptionalEnvKeys,
  defaultSyncIntervalMs: number,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.email) {
    env[keys.SUBSCRIBER_EMAIL] = config.email;
  }
  if (config.organizationName) {
    env[keys.ORGANIZATION_NAME] = config.organizationName;
  }
  if (config.productName) {
    env[keys.PRODUCT_NAME] = config.productName;
  }
  if (config.syncIntervalMs !== defaultSyncIntervalMs) {
    env[keys.SYNC_INTERVAL_MS] = String(config.syncIntervalMs);
  }
  if (config.subscriptionTier) {
    env[keys.SUBSCRIPTION_TIER] = config.subscriptionTier;
  }

  return env;
}
