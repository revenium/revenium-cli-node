import { ENV_KEYS } from "../constants.js";
import type { CopilotConfig } from "../types.js";

export interface GithubCredentialOverrides {
  githubToken?: string;
  githubOrg?: string;
}

export interface GithubCredential {
  token: string;
  orgName: string;
}

export const GITHUB_CREDENTIAL_MISSING_MESSAGE =
  "No GitHub credential available. GitHub Copilot credentials are managed in the Revenium dashboard under Connections > Providers.";

export const GITHUB_CREDENTIAL_HINT = `Pass --github-token and --github-org, or export ${ENV_KEYS.GITHUB_TOKEN} and ${ENV_KEYS.GITHUB_ORG}, to use this command.`;

export function resolveGithubCredential(
  config: CopilotConfig,
  overrides: GithubCredentialOverrides = {},
): GithubCredential | null {
  const token = overrides.githubToken || config.githubToken;
  const orgName = overrides.githubOrg || config.githubOrg;

  if (!token || !orgName) {
    return null;
  }

  return { token, orgName };
}
