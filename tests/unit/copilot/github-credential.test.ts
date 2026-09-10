import { describe, it, expect } from "vitest";
import { resolveGithubCredential } from "../../../src/copilot/config/github-credential.js";
import type { CopilotConfig } from "../../../src/copilot/types.js";

function makeConfig(overrides: Partial<CopilotConfig> = {}): CopilotConfig {
  return {
    reveniumApiKey: "hak_tenant_abc123xyz",
    reveniumEndpoint: "https://api.revenium.ai",
    syncIntervalMs: 300000,
    ...overrides,
  } as CopilotConfig;
}

describe("resolveGithubCredential", () => {
  it("prefers command flags over the loaded configuration", () => {
    const credential = resolveGithubCredential(
      makeConfig({ githubToken: "ghp_config", githubOrg: "config-org" }),
      { githubToken: "ghp_flag", githubOrg: "flag-org" },
    );

    expect(credential).toEqual({ token: "ghp_flag", orgName: "flag-org" });
  });

  it("takes each half of the credential from the highest-priority source that supplies it", () => {
    const credential = resolveGithubCredential(
      makeConfig({ githubToken: "ghp_config", githubOrg: "config-org" }),
      { githubOrg: "flag-org" },
    );

    expect(credential).toEqual({ token: "ghp_config", orgName: "flag-org" });
  });

  it("falls back to the loaded configuration when no flags are passed", () => {
    const credential = resolveGithubCredential(
      makeConfig({ githubToken: "ghp_config", githubOrg: "config-org" }),
    );

    expect(credential).toEqual({ token: "ghp_config", orgName: "config-org" });
  });

  it("returns null when only the token is available", () => {
    expect(resolveGithubCredential(makeConfig({ githubToken: "ghp_config" }))).toBeNull();
  });

  it("returns null when only the organization is available", () => {
    expect(resolveGithubCredential(makeConfig({ githubOrg: "config-org" }))).toBeNull();
  });

  it("returns null when no source supplies a credential", () => {
    expect(resolveGithubCredential(makeConfig())).toBeNull();
  });
});
