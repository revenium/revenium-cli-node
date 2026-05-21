export const GITHUB_API_BASE_URL = "https://api.github.com";

export const COPILOT_CONFIG_DIR = ".github-copilot";

export const REVENIUM_CONFIG_DIR = "revenium";

export const STATE_FILE = "state.json";

export const LOCK_FILE = "revenium-copilot.lock";

export const DIR_MODE = 0o700;

export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_DAYS_PER_REQUEST = 28;

export const MAX_EVENTS_PER_BATCH = 100;

export const DEFAULT_OVERLAP_DAYS = 1;

export const MAX_RECENT_HASHES = 10_000;

export const SERVICE_NAME = "github-copilot-cli";

export const SCOPE_NAME = "github_copilot.log_only";

export const SUBSCRIPTION_TIER_CONFIG = {
  individual: {
    name: "Individual ($10/month)",
  },
  business: {
    name: "Business ($19/user/month)",
  },
  enterprise: {
    name: "Enterprise ($39/user/month)",
  },
} as const;

export const SUBSCRIPTION_TIERS = Object.keys(SUBSCRIPTION_TIER_CONFIG) as ReadonlyArray<
  keyof typeof SUBSCRIPTION_TIER_CONFIG
>;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIER_CONFIG;

export const ENV_KEYS = {
  GITHUB_TOKEN: "GITHUB_TOKEN",
  GITHUB_ORG: "GITHUB_ORG",
  REVENIUM_API_KEY: "REVENIUM_API_KEY",
  REVENIUM_ENDPOINT: "REVENIUM_ENDPOINT",
  SUBSCRIBER_EMAIL: "REVENIUM_SUBSCRIBER_EMAIL",
  ORGANIZATION_NAME: "REVENIUM_ORGANIZATION_NAME",
  PRODUCT_NAME: "REVENIUM_PRODUCT_NAME",
  SYNC_INTERVAL_MS: "REVENIUM_SYNC_INTERVAL_MS",
  SUBSCRIPTION_TIER: "COPILOT_SUBSCRIPTION_TIER",
} as const;
