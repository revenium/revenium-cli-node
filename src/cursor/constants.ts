export const CURSOR_API_BASE_URL = "https://api.cursor.com";

export const CURSOR_CONFIG_DIR = ".cursor";

export const REVENIUM_CONFIG_DIR = "revenium";

export const STATE_FILE = "state.json";

export const LOCK_FILE = "revenium-cursor.lock";

export const DIR_MODE = 0o700;

export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_DAYS_PER_REQUEST = 30;

export const MAX_EVENTS_PER_BATCH = 100;

export const DEFAULT_OVERLAP_MULTIPLIER = 2;

export const MAX_RECENT_HASHES = 10_000;

export const SERVICE_NAME = "cursor-ide";

export const SCOPE_NAME = "cursor_admin_api";

export const SUBSCRIPTION_TIER_CONFIG = {
  pro: {
    name: "Pro ($20/month)",
  },
  business: {
    name: "Business ($40/seat/month)",
  },
  enterprise: {
    name: "Enterprise (custom)",
  },
  api: {
    name: "API / Pay-as-you-go",
  },
} as const;

export const SUBSCRIPTION_TIERS = Object.keys(SUBSCRIPTION_TIER_CONFIG) as ReadonlyArray<
  keyof typeof SUBSCRIPTION_TIER_CONFIG
>;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIER_CONFIG;

export const ENV_KEYS = {
  CURSOR_API_KEY: "CURSOR_API_KEY",
  REVENIUM_API_KEY: "REVENIUM_API_KEY",
  REVENIUM_ENDPOINT: "REVENIUM_ENDPOINT",
  SUBSCRIBER_EMAIL: "REVENIUM_SUBSCRIBER_EMAIL",
  ORGANIZATION_NAME: "REVENIUM_ORGANIZATION_NAME",
  PRODUCT_NAME: "REVENIUM_PRODUCT_NAME",
  SYNC_INTERVAL_MS: "REVENIUM_SYNC_INTERVAL_MS",
  SUBSCRIPTION_TIER: "CURSOR_SUBSCRIPTION_TIER",
} as const;
