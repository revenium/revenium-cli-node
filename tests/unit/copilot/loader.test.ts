import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { loadConfig, findUnknownConfigKeys } from "../../../src/copilot/config/loader.js";
import { ENV_KEYS } from "../../../src/copilot/constants.js";

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

describe("copilot loadConfig — endpoint normalization", () => {
  it("normalizes a stored endpoint that already carries the OTLP path, keeping the gateway prefix", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [
        "REVENIUM_API_KEY=hak_tenant_abc123xyz",
        "REVENIUM_ENDPOINT=https://gw.example.com/revenium/meter/v2/otlp",
      ].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.reveniumEndpoint).toBe("https://gw.example.com/revenium");
  });

  it("keeps a plain gateway prefix untouched", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [
        "REVENIUM_API_KEY=hak_tenant_abc123xyz",
        "REVENIUM_ENDPOINT=https://gw.example.com/revenium",
      ].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.reveniumEndpoint).toBe("https://gw.example.com/revenium");
  });
});

describe("copilot findUnknownConfigKeys", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("names a key written from the old README names", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [FILE_CONFIG, "REVENIUM_EMAIL=developer@company.com"].join("\n"),
    );

    await expect(findUnknownConfigKeys()).resolves.toEqual(["REVENIUM_EMAIL"]);
  });

  it("does not name the GitHub credential keys", async () => {
    vi.mocked(readFile).mockResolvedValue(FILE_CONFIG);

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });

  it("names nothing for a file holding only the keys setup writes", async () => {
    vi.mocked(readFile).mockResolvedValue(
      Object.values(ENV_KEYS)
        .map((key) => `${key}=value`)
        .join("\n"),
    );

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });

  it("returns an empty list when the config file cannot be read", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });
});
