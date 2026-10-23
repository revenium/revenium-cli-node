import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/copilot/config/writer.js", () => ({
  writeConfig: vi.fn().mockResolvedValue({
    envPath: "/tmp/.github-copilot/revenium/revenium.env",
    fishPath: "/tmp/.github-copilot/revenium/revenium.fish",
  }),
}));

vi.mock("../../../src/copilot/config/loader.js", () => ({
  getConfigPath: vi.fn().mockReturnValue("/tmp/.github-copilot/revenium/revenium.env"),
  findUnknownConfigKeys: vi.fn().mockResolvedValue([]),
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
import { findUnknownConfigKeys } from "../../../src/copilot/config/loader.js";
import { checkEndpointHealth } from "../../../src/_core/api/health-check.js";
import inquirer from "inquirer";
import { stubTty, restoreTty } from "../../helpers/tty.js";

describe("copilot setupCommand", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreTty();
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
    stubTty(true);
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

  it("warns about retired keys found in the existing config", async () => {
    vi.mocked(findUnknownConfigKeys).mockResolvedValue(["REVENIUM_EMAIL"]);

    await setupCommand({
      reveniumApiKey: "hak_tenant_abc123xyz",
      endpoint: "https://api.revenium.ai",
      subscriptionTier: "business",
    });

    const output = vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .join("\n");

    expect(output).toContain("REVENIUM_EMAIL");
    expect(output).toContain("REVENIUM_SUBSCRIBER_EMAIL");
  });
});

describe("copilot setupCommand key scope", () => {
  class ExitError extends Error {}

  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(findUnknownConfigKeys).mockResolvedValue([]);
  });

  afterEach(() => {
    restoreTty();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stops a read key before any request reaches the endpoint", async () => {
    await expect(
      setupCommand({
        reveniumApiKey: "rev_rk_TENANT1_0123456789abcdef",
        endpoint: "https://api.revenium.ai",
        subscriptionTier: "business",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("warns about a write key and still completes setup", async () => {
    await setupCommand({
      reveniumApiKey: "rev_sk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
      subscriptionTier: "business",
    });

    expect(logged.join("\n")).toContain("write key");
    expect(writeConfig).toHaveBeenCalled();
  });

  it("prints no scope warning for a metering key", async () => {
    await setupCommand({
      reveniumApiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
      subscriptionTier: "business",
    });

    expect(logged.join("\n")).not.toContain("write key");
  });

  it("stops a malformed legacy key supplied as a flag", async () => {
    await expect(
      setupCommand({
        reveniumApiKey: "hak_short",
        endpoint: "https://api.revenium.ai",
        subscriptionTier: "business",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint typed at the prompt and keeps loopback working", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      reveniumApiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
      subscriptionTier: "business",
    } as never);

    await setupCommand({});

    const endpointQuestion = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "endpoint") as {
      validate: (input: string) => true | string;
    };

    expect(endpointQuestion.validate("http://[::1]:18962")).toContain(
      "Endpoint must use HTTPS (except for localhost)",
    );
    expect(endpointQuestion.validate("https://user:pass@api.revenium.ai")).toContain(
      "embedded credentials",
    );
    expect(endpointQuestion.validate("http://localhost:4318")).toBe(true);
    expect(endpointQuestion.validate("https://api.revenium.ai")).toBe(true);
  });

  it("asks for a metering key in the interactive prompt", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      reveniumApiKey: "rev_mk_TENANT1_0123456789abcdef",
      subscriptionTier: "business",
    } as never);

    await setupCommand({ endpoint: "https://api.revenium.ai" });

    const apiKeyQuestion = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "reveniumApiKey") as {
      message: string;
    };

    expect(apiKeyQuestion.message).toContain("rev_mk_");
  });
});

describe("copilot setupCommand scripted run without a terminal", () => {
  class ExitError extends Error {}

  const API_KEY = "hak_tenant_abc123xyz";

  let errors: string[];

  beforeEach(() => {
    errors = [];
    stubTty(false);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    vi.mocked(findUnknownConfigKeys).mockResolvedValue([]);
  });

  afterEach(() => {
    restoreTty();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("writes configuration without prompting when there is no TTY", async () => {
    await setupCommand({ reveniumApiKey: API_KEY, subscriptionTier: "business" });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0]).toMatchObject({
      reveniumApiKey: API_KEY,
      subscriptionTier: "business",
    });
  });

  it("fails with the missing flag and never writes", async () => {
    await expect(setupCommand({ reveniumApiKey: API_KEY })).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--subscription-tier");
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint and a malformed email before the key is sent", async () => {
    await expect(
      setupCommand({
        reveniumApiKey: API_KEY,
        subscriptionTier: "business",
        endpoint: "http://[::1]:18962",
        email: "not-an-email",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty optional value", async () => {
    await setupCommand({
      reveniumApiKey: API_KEY,
      subscriptionTier: "business",
      organizationName: "",
    });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0].organizationName).toBeUndefined();
  });

  it("still prompts interactively", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      reveniumApiKey: API_KEY,
      subscriptionTier: "business",
    } as never);

    await setupCommand({});

    expect(inquirer.prompt).toHaveBeenCalled();
  });

  it("does not prompt when stdout is piped and stdin is a terminal", async () => {
    stubTty(true, false);

    await setupCommand({ reveniumApiKey: API_KEY, subscriptionTier: "business" });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(writeConfig).toHaveBeenCalled();
  });

  it("fails with the valid tiers and never writes when the tier is unknown", async () => {
    await expect(
      setupCommand({ reveniumApiKey: API_KEY, subscriptionTier: "bsuiness" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--subscription-tier");
    expect(errors.join("\n")).toContain("business");
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
