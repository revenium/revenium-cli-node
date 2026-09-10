import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/copilot/config/writer.js", () => ({
  writeConfig: vi.fn().mockResolvedValue({
    envPath: "/tmp/.github-copilot/revenium/revenium.env",
    fishPath: "/tmp/.github-copilot/revenium/revenium.fish",
  }),
}));

vi.mock("../../../src/copilot/config/loader.js", () => ({
  getConfigPath: vi.fn().mockReturnValue("/tmp/.github-copilot/revenium/revenium.env"),
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 12 }),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  updateShellProfile: vi.fn().mockResolvedValue({ success: true, message: "Profile updated" }),
  getManualInstructions: vi.fn().mockReturnValue("source ~/.github-copilot/revenium/revenium.env"),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

import { setupCommand } from "../../../src/copilot/commands/setup.js";
import { writeConfig } from "../../../src/copilot/config/writer.js";
import inquirer from "inquirer";

describe("copilot setupCommand", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("never asks for a GitHub token", async () => {
    await setupCommand({
      reveniumApiKey: "hak_tenant_abc123xyz",
      endpoint: "https://api.revenium.ai",
      subscriptionTier: "business",
    });

    const promptedNames = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .map((question) => (question as { name?: string }).name);

    expect(promptedNames).not.toContain("githubToken");
    expect(promptedNames).not.toContain("githubOrg");
  });

  it("writes no GitHub credential even when the interactive answers carry one", async () => {
    vi.mocked(inquirer.prompt).mockResolvedValue({
      subscriptionTier: "business",
      githubToken: "ghp_leaked0000000000000000",
      githubOrg: "leaked-org",
    } as never);

    await setupCommand({
      reveniumApiKey: "hak_tenant_abc123xyz",
      endpoint: "https://api.revenium.ai",
    });

    const writtenConfig = vi.mocked(writeConfig).mock.calls[0][0];

    expect(vi.mocked(inquirer.prompt)).toHaveBeenCalled();
    expect(writtenConfig.githubToken).toBeUndefined();
    expect(writtenConfig.githubOrg).toBeUndefined();
  });
});
