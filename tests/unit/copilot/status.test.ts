import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CopilotConfig } from "../../../src/copilot/types.js";

const mocks = vi.hoisted(() => ({
  checkCopilotAccess: vi.fn(),
}));

vi.mock("../../../src/copilot/config/loader.js", () => ({
  configExists: () => true,
  getConfigPath: () => "/tmp/.revenium/copilot.json",
  loadConfig: vi.fn(),
  findUnknownConfigKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/copilot/core/github-client.js", () => ({
  checkCopilotAccess: mocks.checkCopilotAccess,
}));

vi.mock("../../../src/copilot/core/sync/state-manager.js", () => ({
  loadState: async () => ({
    lastSyncTimestamp: 0,
    lastSyncEventCount: 0,
    totalEventsSynced: 0,
    sentRecords: {},
  }),
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, message: "ok", latencyMs: 1 }),
}));

import { statusCommand } from "../../../src/copilot/commands/status.js";
import { loadConfig } from "../../../src/copilot/config/loader.js";

const CONFIG: CopilotConfig = {
  githubToken: "ghp_token",
  githubOrg: "acme",
  reveniumApiKey: "hak_tenant_abc123xyz",
  reveniumEndpoint: "https://api.revenium.ai",
  syncIntervalMs: 300000,
};

let output = "";

describe("copilot statusCommand connectivity", () => {
  beforeEach(() => {
    output = "";
    vi.mocked(loadConfig).mockResolvedValue(CONFIG);
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

  it("reports connected when the organization and its metrics both answer", async () => {
    mocks.checkCopilotAccess.mockResolvedValue({ status: "connected" });

    await statusCommand();

    expect(output).toContain("GitHub Copilot API connected");
  });

  it("names the organization when it cannot be reached", async () => {
    mocks.checkCopilotAccess.mockResolvedValue({ status: "organization-unreachable" });

    await statusCommand();

    expect(output).toContain('GitHub organization "acme" could not be reached with this token');
    expect(output).not.toContain("GitHub Copilot API connected");
  });

  it("flags a credential that reaches the organization but cannot read the metrics", async () => {
    mocks.checkCopilotAccess.mockResolvedValue({ status: "metrics-unreadable" });

    await statusCommand();

    expect(output).toContain("GitHub Copilot usage metrics could not be read");
    expect(output).toContain("Copilot usage metrics policy is enabled");
    expect(output).not.toContain("GitHub Copilot API connected");
  });

  it("prints the underlying error when the probe fails for another reason", async () => {
    mocks.checkCopilotAccess.mockResolvedValue({
      status: "failed",
      message: "GitHub API error: 503 Service Unavailable",
    });

    await statusCommand();

    expect(output).toContain("GitHub Copilot API error: GitHub API error: 503 Service Unavailable");
    expect(output).not.toContain("could not be reached with this token");
  });
});
