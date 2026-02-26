export const CLAUDE_CONFIG_DIR = ".claude";

export const SUBSCRIPTION_TIER_CONFIG = {
  pro: {
    name: "Pro (~$20 USD/month or local equivalent)",
    multiplier: 0.16,
  },
  max_5x: {
    name: "Max 5x (~$100 USD/month or local equivalent)",
    multiplier: 0.16,
  },
  max_20x: {
    name: "Max 20x (~$200 USD/month or local equivalent)",
    multiplier: 0.08,
  },
  team_premium: {
    name: "Team Premium (~$125 USD/seat or local equivalent)",
    multiplier: 0.2,
  },
  enterprise: {
    name: "Enterprise (custom)",
    multiplier: 0.05,
  },
  api: {
    name: "API (no subscription)",
    multiplier: 1.0,
  },
} as const;

export const SUBSCRIPTION_TIERS = Object.keys(SUBSCRIPTION_TIER_CONFIG) as ReadonlyArray<
  keyof typeof SUBSCRIPTION_TIER_CONFIG
>;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIER_CONFIG;

export function getCostMultiplier(tier: SubscriptionTier): number {
  return SUBSCRIPTION_TIER_CONFIG[tier].multiplier;
}

export const ENV_VARS = {
  TELEMETRY_ENABLED: "CLAUDE_CODE_ENABLE_TELEMETRY",
  OTLP_ENDPOINT: "OTEL_EXPORTER_OTLP_ENDPOINT",
  OTLP_HEADERS: "OTEL_EXPORTER_OTLP_HEADERS",
  OTLP_PROTOCOL: "OTEL_EXPORTER_OTLP_PROTOCOL",
  SUBSCRIBER_EMAIL: "REVENIUM_SUBSCRIBER_EMAIL",
  SUBSCRIPTION: "CLAUDE_CODE_SUBSCRIPTION",
  COST_MULTIPLIER: "CLAUDE_CODE_COST_MULTIPLIER",
  ORGANIZATION_ID: "REVENIUM_ORGANIZATION_ID",
  PRODUCT_ID: "REVENIUM_PRODUCT_ID",
} as const;
