import type { CopilotSurface } from "./types.js";

export const GITHUB_API_BASE_URL = "https://api.github.com";

export const COPILOT_CONFIG_DIR = ".github-copilot";

export const REVENIUM_CONFIG_DIR = "revenium";

export const STATE_FILE = "state.json";

export const LOCK_FILE = "revenium-copilot.lock";

export const DIR_MODE = 0o700;

export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export const USAGE_RETENTION_DAYS = 28;

export const DEFAULT_LOOKBACK_DAYS = USAGE_RETENTION_DAYS;

export const GITHUB_API_VERSION = "2026-03-10";

export const MAX_EVENTS_PER_BATCH = 100;

export const DEFAULT_OVERLAP_DAYS = 1;

export const SURFACE_MODEL: Record<Exclude<CopilotSurface, "billing">, string> = {
  cli: "copilot-cli",
  app: "copilot-app",
  completion: "copilot-completion",
  credit: "copilot-credit",
};

export const BILLING_PERMISSION_HINT =
  "Billing usage needs the organization permission Administration (read-only) on a token owned by an organization owner, and the Copilot usage metrics policy enabled (GitHub Org > Settings > Copilot > Policies). The README quick start lists the full set of permissions the credential needs.";

export const ORGANIZATION_UNREACHABLE_HINT =
  "Check the organization slug and that this token has access to it.";

export const COPILOT_METRICS_POLICY_HINT =
  "If the organization is active, confirm the Copilot usage metrics policy is enabled (GitHub Org > Settings > Copilot > Policies) and that this token can read it.";

export const UNKNOWN_LANGUAGE = "unknown";

export const UNKNOWN_EDITOR = "unknown";

export const UNKNOWN_MODEL = "unknown";

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
