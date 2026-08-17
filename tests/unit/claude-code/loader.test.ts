import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs to control existsSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

// Mock node:fs/promises to control readFile
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock node:os to control homedir
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../../../src/claude-code/config/loader.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);

/**
 * Build a minimal valid env file content string with the given extra lines.
 */
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

describe("loadConfig — subscriptionTier resolution", () => {
  it("uses CLAUDE_CODE_SUBSCRIPTION_TIER when only it is set", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ CLAUDE_CODE_SUBSCRIPTION_TIER: "pro" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.subscriptionTier).toBe("pro");
  });

  it("uses CLAUDE_CODE_SUBSCRIPTION when only it is set (backward compat)", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({ CLAUDE_CODE_SUBSCRIPTION: "max_5x" }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.subscriptionTier).toBe("max_5x");
  });

  it("prefers CLAUDE_CODE_SUBSCRIPTION_TIER over CLAUDE_CODE_SUBSCRIPTION when both are set", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({
        CLAUDE_CODE_SUBSCRIPTION_TIER: "enterprise",
        CLAUDE_CODE_SUBSCRIPTION: "pro",
      }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.subscriptionTier).toBe("enterprise");
  });

  it("sets subscriptionTier to undefined when neither env var is set", async () => {
    mockReadFile.mockResolvedValue(buildEnvContent() as unknown as Buffer);

    const config = await loadConfig();
    expect(config?.subscriptionTier).toBeUndefined();
  });

  it("falls back to CLAUDE_CODE_SUBSCRIPTION when SUBSCRIPTION_TIER is empty string", async () => {
    mockReadFile.mockResolvedValue(
      buildEnvContent({
        CLAUDE_CODE_SUBSCRIPTION_TIER: "",
        CLAUDE_CODE_SUBSCRIPTION: "max_5x",
      }) as unknown as Buffer,
    );

    const config = await loadConfig();
    expect(config?.subscriptionTier).toBe("max_5x");
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
