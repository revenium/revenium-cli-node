import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig, getConfigPath } from "../../../src/claude-code/config/loader.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);

function buildEnvContent(extras: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.revenium.ai/meter/v2/otlp",
    OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=hak_testkey123",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  };

  const merged = { ...base, ...extras };
  return Object.entries(merged)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

describe("loadConfig — retired subscription-tier vars are tolerated, not surfaced", () => {
  it("loads cleanly from an old env file that still sets CLAUDE_CODE_SUBSCRIPTION_TIER and CLAUDE_CODE_SUBSCRIPTION", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({
        CLAUDE_CODE_SUBSCRIPTION_TIER: "enterprise",
        CLAUDE_CODE_SUBSCRIPTION: "pro",
      }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("hak_testkey123");
    expect("subscriptionTier" in (config as object)).toBe(false);
  });

  it("does not surface a subscriptionTier field even when neither legacy var is set", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect("subscriptionTier" in (config as object)).toBe(false);
  });
});

describe("loadConfig — extraUsageEnabled parsing", () => {
  it("parses '1' as true", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ CLAUDE_CODE_EXTRA_USAGE_ENABLED: "1" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.extraUsageEnabled).toBe(true);
  });

  it("parses '0' as false", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ CLAUDE_CODE_EXTRA_USAGE_ENABLED: "0" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.extraUsageEnabled).toBe(false);
  });

  it("returns undefined when CLAUDE_CODE_EXTRA_USAGE_ENABLED is absent", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config?.extraUsageEnabled).toBeUndefined();
  });

  it("returns undefined for EXTRA_USAGE_ENABLED set to unrecognized value like 'true'", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ CLAUDE_CODE_EXTRA_USAGE_ENABLED: "true" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.extraUsageEnabled).toBeUndefined();
  });
});

describe("loadConfig — session attribution teamId", () => {
  it("loads REVENIUM_TEAM_ID when configured", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ REVENIUM_TEAM_ID: "teamHash123" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.teamId).toBe("teamHash123");
  });

  it("leaves teamId undefined when the backend derives it from the metering key", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config?.teamId).toBeUndefined();
  });
});

describe("loadConfig — management API endpoint override", () => {
  it("loads REVENIUM_MGMT_ENDPOINT when configured", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({
        REVENIUM_MGMT_ENDPOINT: "https://mgmt.example.com",
      }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.managementEndpoint).toBe("https://mgmt.example.com");
  });

  it("leaves managementEndpoint undefined when not configured (default resolved at call time)", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config?.managementEndpoint).toBeUndefined();
  });
});

describe("loadConfig — backward compatibility", () => {
  it("loads a config without new fields without errors", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("hak_testkey123");
    expect(config?.endpoint).toBe("https://api.revenium.ai");
  });

  it("does NOT include costMultiplierOverride in returned config", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect("costMultiplierOverride" in (config as object)).toBe(false);
  });
});

describe("loadConfig — returns null cases", () => {
  it("returns null when config file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it("returns null when headers do not contain a valid api key", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=invalid_key" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config).toBeNull();
  });
});

describe("getConfigPath — REVENIUM_CONFIG_PATH override", () => {
  afterEach(() => {
    delete process.env.REVENIUM_CONFIG_PATH;
  });

  it("uses the override path when REVENIUM_CONFIG_PATH is set", () => {
    process.env.REVENIUM_CONFIG_PATH = "/tmp/revenium-local-e2e.env";
    expect(getConfigPath()).toBe("/tmp/revenium-local-e2e.env");
  });

  it("trims surrounding whitespace from the override path", () => {
    process.env.REVENIUM_CONFIG_PATH = "  /tmp/revenium-local-e2e.env  ";
    expect(getConfigPath()).toBe("/tmp/revenium-local-e2e.env");
  });

  it("falls back to ~/.claude/revenium.env when unset or blank", () => {
    process.env.REVENIUM_CONFIG_PATH = "   ";
    expect(getConfigPath()).toContain(".claude");
    expect(getConfigPath()).toContain("revenium.env");
    delete process.env.REVENIUM_CONFIG_PATH;
    expect(getConfigPath()).toContain("revenium.env");
  });
});
