import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/cursor/config/writer.js", () => ({
  writeConfig: vi.fn().mockResolvedValue({
    envPath: "/tmp/.cursor/revenium.env",
    fishPath: "/tmp/.cursor/revenium.fish",
  }),
}));

vi.mock("../../../src/cursor/config/loader.js", () => ({
  getConfigPath: vi.fn().mockReturnValue("/tmp/.cursor/revenium.env"),
  findUnknownConfigKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/cursor/core/cursor-client.js", () => ({
  testConnectivity: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 12 }),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  updateShellProfile: vi.fn().mockResolvedValue({ success: true, message: "Profile updated" }),
  getManualInstructions: vi.fn().mockReturnValue(""),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

import { setupCommand } from "../../../src/cursor/commands/setup.js";
import { writeConfig } from "../../../src/cursor/config/writer.js";
import { testConnectivity } from "../../../src/cursor/core/cursor-client.js";
import { checkEndpointHealth } from "../../../src/_core/api/health-check.js";
import inquirer from "inquirer";
import { stubTty, restoreTty } from "../../helpers/tty.js";

class ExitError extends Error {}

const options = {
  cursorApiKey: "key_cursor_0123456789",
  endpoint: "https://api.revenium.ai",
  subscriptionTier: "business",
};

describe("cursor setupCommand key scope", () => {
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
  });

  afterEach(() => {
    restoreTty();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stops a read key before any request reaches Cursor or Revenium", async () => {
    await expect(
      setupCommand({ ...options, reveniumApiKey: "rev_rk_TENANT1_0123456789abcdef" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(testConnectivity).not.toHaveBeenCalled();
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("warns about a write key and still completes setup", async () => {
    await setupCommand({ ...options, reveniumApiKey: "rev_sk_TENANT1_0123456789abcdef" });

    expect(logged.join("\n")).toContain("write key");
    expect(writeConfig).toHaveBeenCalled();
  });

  it("prints no scope warning for a metering key", async () => {
    await setupCommand({ ...options, reveniumApiKey: "rev_mk_TENANT1_0123456789abcdef" });

    expect(logged.join("\n")).not.toContain("write key");
  });

  it("stops a malformed legacy key supplied as a flag", async () => {
    await expect(setupCommand({ ...options, reveniumApiKey: "hak_short" })).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(testConnectivity).not.toHaveBeenCalled();
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint typed at the prompt and keeps loopback working", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      reveniumApiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
    } as never);

    await setupCommand({
      cursorApiKey: options.cursorApiKey,
      subscriptionTier: options.subscriptionTier,
    });

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
    } as never);

    await setupCommand({ cursorApiKey: options.cursorApiKey, endpoint: options.endpoint });

    const apiKeyQuestion = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "reveniumApiKey") as {
      message: string;
    };

    expect(apiKeyQuestion.message).toContain("rev_mk_");
  });
});

describe("cursor setupCommand scripted run without a terminal", () => {
  const scripted = {
    cursorApiKey: options.cursorApiKey,
    reveniumApiKey: "hak_tenant_abc123xyz",
    subscriptionTier: options.subscriptionTier,
  };

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
  });

  afterEach(() => {
    restoreTty();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("writes configuration without prompting when there is no TTY", async () => {
    await setupCommand(scripted);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0]).toMatchObject({
      cursorApiKey: scripted.cursorApiKey,
      reveniumApiKey: scripted.reveniumApiKey,
    });
  });

  it("fails with the missing flag and never writes", async () => {
    await expect(setupCommand({ cursorApiKey: options.cursorApiKey })).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(errors.join("\n")).toContain("--api-key");
    expect(errors.join("\n")).toContain("--subscription-tier");
    expect(testConnectivity).not.toHaveBeenCalled();
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint and a malformed email before the key is sent", async () => {
    await expect(
      setupCommand({ ...scripted, endpoint: "http://[::1]:18962", email: "not-an-email" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(testConnectivity).not.toHaveBeenCalled();
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty optional value", async () => {
    await setupCommand({ ...scripted, organizationName: "" });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0].organizationName).toBeUndefined();
  });

  it("still prompts interactively", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue(scripted as never);

    await setupCommand({});

    expect(inquirer.prompt).toHaveBeenCalled();
  });

  it("does not prompt when stdout is piped and stdin is a terminal", async () => {
    stubTty(true, false);

    await setupCommand(scripted);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(writeConfig).toHaveBeenCalled();
  });

  it("fails with the valid tiers and never writes when the tier is unknown", async () => {
    await expect(
      setupCommand({ ...scripted, subscriptionTier: "bsuiness" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--subscription-tier");
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
