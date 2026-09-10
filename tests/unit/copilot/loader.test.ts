import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { loadConfig } from "../../../src/copilot/config/loader.js";

const FILE_CONFIG = [
  "REVENIUM_API_KEY=hak_tenant_abc123xyz",
  "GITHUB_TOKEN=ghp_file",
  "GITHUB_ORG=file-org",
].join("\n");

describe("copilot loadConfig — GitHub credential resolution", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(FILE_CONFIG);
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ORG;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ORG;
  });

  it("prefers the environment over the legacy configuration file", async () => {
    process.env.GITHUB_TOKEN = "ghp_env";
    process.env.GITHUB_ORG = "env-org";

    const config = await loadConfig();

    expect(config?.githubToken).toBe("ghp_env");
    expect(config?.githubOrg).toBe("env-org");
  });

  it("keeps the legacy file value for the half the environment does not supply", async () => {
    process.env.GITHUB_ORG = "env-org";

    const config = await loadConfig();

    expect(config?.githubToken).toBe("ghp_file");
    expect(config?.githubOrg).toBe("env-org");
  });

  it("leaves the credential undefined when neither source supplies it", async () => {
    vi.mocked(readFile).mockResolvedValue("REVENIUM_API_KEY=hak_tenant_abc123xyz");

    const config = await loadConfig();

    expect(config?.githubToken).toBeUndefined();
    expect(config?.githubOrg).toBeUndefined();
  });
});
