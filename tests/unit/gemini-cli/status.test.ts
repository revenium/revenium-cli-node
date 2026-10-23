import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/gemini-cli/config/loader.js", () => ({
  loadConfig: vi.fn(),
  configExists: vi.fn().mockReturnValue(true),
  getConfigPath: vi.fn().mockReturnValue("/tmp/.gemini/revenium.env"),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  isProfileConfigured: vi.fn(),
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, message: "ok", latencyMs: 1 }),
}));

import { statusCommand } from "../../../src/gemini-cli/commands/status.js";
import { loadConfig } from "../../../src/gemini-cli/config/loader.js";
import { isProfileConfigured } from "../../../src/_core/shell/profile-updater.js";
import { SHELL_PROFILE_MARKER } from "../../../src/gemini-cli/constants.js";

const baseConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  legacy: false,
};

let logged: string[];

describe("statusCommand", () => {
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    vi.mocked(isProfileConfigured).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("warns that a pre-change configuration carries the key as a resource attribute", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ ...baseConfig, legacy: true });

    await statusCommand();

    expect(logged.join("\n")).toContain("Configuration is outdated");
  });

  it("stays silent about outdated configuration once the key is a header", async () => {
    await statusCommand();

    expect(logged.join("\n")).not.toContain("Configuration is outdated");
  });

  it("checks the profile for the wrapper launcher rather than the loaded environment", async () => {
    await statusCommand();

    expect(isProfileConfigured).toHaveBeenCalledWith(
      SHELL_PROFILE_MARKER,
      "revenium-gemini run --",
    );
  });

  it("tells the user to run setup when the wrapper is missing from the profile", async () => {
    vi.mocked(isProfileConfigured).mockResolvedValue(false);

    await statusCommand();

    const output = logged.join("\n");
    expect(output).toContain("Gemini wrapper is not installed in the shell profile");
    expect(output).not.toContain("source ");
  });
});
