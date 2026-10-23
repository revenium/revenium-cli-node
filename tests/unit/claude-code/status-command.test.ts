import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClaudeCodeConfig } from "../../../src/claude-code/config/loader.js";

const mocks = vi.hoisted(() => ({
  isCursorProvidedConfig: vi.fn(),
  applyTelemetryEnv: vi.fn(),
  readTelemetryEnvSources: vi.fn(),
  resolveLogToolDetails: vi.fn(),
}));

vi.mock("../../../src/claude-code/config/loader.js", () => ({
  configExists: () => true,
  getConfigPath: () => "/home/testuser/.cursor/revenium/revenium.env",
  isCursorProvidedConfig: mocks.isCursorProvidedConfig,
  loadConfig: vi.fn(),
}));

vi.mock("../../../src/claude-code/config/claude-settings.js", () => ({
  applyTelemetryEnv: mocks.applyTelemetryEnv,
  readTelemetryEnvSources: mocks.readTelemetryEnvSources,
  resolveLogToolDetails: mocks.resolveLogToolDetails,
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, message: "ok", latencyMs: 1 }),
}));

import { statusCommand } from "../../../src/claude-code/commands/status.js";
import { loadConfig } from "../../../src/claude-code/config/loader.js";

const CONFIG: ClaudeCodeConfig = {
  apiKey: "hak_tenant_abc123xyz",
  endpoint: "https://api.revenium.ai",
  email: "dev@revenium.io",
  organizationName: "Revenium",
  productName: "Cursor IDE",
};

let output = "";

describe("claude-code statusCommand on a Cursor-written configuration", () => {
  beforeEach(() => {
    output = "";
    vi.mocked(loadConfig).mockResolvedValue(CONFIG);
    mocks.applyTelemetryEnv.mockResolvedValue({ applied: true, path: "/home/testuser/.claude" });
    mocks.readTelemetryEnvSources.mockResolvedValue({
      managed: { path: "/managed-settings.json", env: {} },
      effective: {
        path: "/home/testuser/.claude/settings.json",
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.revenium.ai/v1/traces",
          OTEL_LOG_TOOL_DETAILS: "1",
        },
      },
    });
    mocks.resolveLogToolDetails.mockResolvedValue({ value: true });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output += args.join(" ") + "\n";
    });
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      output += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reports the configuration as found and names the Cursor setup as its source", async () => {
    mocks.isCursorProvidedConfig.mockReturnValue(true);

    await statusCommand();

    expect(output).toContain("Configuration file found");
    expect(output).toContain("This configuration was written by the Cursor setup.");
    expect(output).toContain("Claude Code telemetry settings were not checked.");
    expect(mocks.readTelemetryEnvSources).not.toHaveBeenCalled();
  });

  it("does not claim Claude Code telemetry is enabled or missing from a settings file", async () => {
    mocks.isCursorProvidedConfig.mockReturnValue(true);

    await statusCommand();

    expect(output).not.toContain("for Claude Code in");
    expect(output).not.toContain("Skill attribution:");
  });

  it("refuses to repair and points at setup instead of rewriting Claude Code settings", async () => {
    mocks.isCursorProvidedConfig.mockReturnValue(true);

    await statusCommand({ fix: true });

    expect(output).toContain(
      "Nothing to repair: this configuration was written by the Cursor setup.",
    );
    expect(output).toContain("Run `revenium-metering setup` to also meter Claude Code.");
    expect(mocks.applyTelemetryEnv).not.toHaveBeenCalled();
  });
});

describe("claude-code statusCommand on a Claude Code configuration", () => {
  beforeEach(() => {
    output = "";
    vi.mocked(loadConfig).mockResolvedValue(CONFIG);
    mocks.isCursorProvidedConfig.mockReturnValue(false);
    mocks.applyTelemetryEnv.mockResolvedValue({
      applied: true,
      path: "/home/testuser/.claude/settings.json",
    });
    mocks.readTelemetryEnvSources.mockResolvedValue({
      managed: { path: "/managed-settings.json", env: {} },
      effective: {
        path: "/home/testuser/.claude/settings.json",
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.revenium.ai/v1/traces",
          OTEL_LOG_TOOL_DETAILS: "1",
        },
      },
    });
    mocks.resolveLogToolDetails.mockResolvedValue({ value: true });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output += args.join(" ") + "\n";
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("still reports telemetry and skill attribution", async () => {
    await statusCommand();

    expect(output).toContain("Telemetry is enabled for Claude Code");
    expect(output).toContain("Skill attribution:");
    expect(output).not.toContain("written by the Cursor setup");
  });

  it("still repairs the telemetry settings with --fix", async () => {
    await statusCommand({ fix: true });

    expect(mocks.applyTelemetryEnv).toHaveBeenCalledWith(CONFIG);
    expect(output).toContain("Re-applied the telemetry settings");
  });
});
