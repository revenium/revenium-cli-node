import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn(),
}));

vi.mock("../../../src/gemini-cli/config/writer.js", () => ({
  writeConfig: vi.fn().mockResolvedValue("/tmp/.gemini/revenium.env"),
  getConfigFilePath: vi.fn().mockReturnValue("/tmp/.gemini/revenium.env"),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  updateShellProfile: vi.fn().mockResolvedValue({ success: true, message: "Profile updated" }),
  getManualInstructions: vi.fn().mockReturnValue(""),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

import { setupCommand } from "../../../src/gemini-cli/commands/setup.js";
import { checkEndpointHealth } from "../../../src/_core/api/health-check.js";
import { writeConfig } from "../../../src/gemini-cli/config/writer.js";
import { updateShellProfile } from "../../../src/_core/shell/profile-updater.js";
import inquirer from "inquirer";
import { stubTty, restoreTty } from "../../helpers/tty.js";

const options = {
  apiKey: "hak_tenant_testkey123",
  endpoint: "https://api.revenium.ai",
  skipShellUpdate: true,
};

class ExitError extends Error {}

beforeEach(() => {
  stubTty(false);
});

afterEach(() => {
  restoreTty();
});

describe("setupCommand validation", () => {
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
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("validates against the base endpoint the written configuration points Gemini at", async () => {
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });

    await setupCommand(options);

    expect(vi.mocked(checkEndpointHealth).mock.calls[0][0]).toBe("https://api.revenium.ai");
  });

  it("keeps a gateway path prefix in the base endpoint it validates and writes", async () => {
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });

    await setupCommand({
      ...options,
      endpoint: "https://gw.example.com/revenium/meter/v2/otlp",
    });

    expect(vi.mocked(checkEndpointHealth).mock.calls[0][0]).toBe("https://gw.example.com/revenium");
    expect(vi.mocked(writeConfig).mock.calls[0][0]).toMatchObject({
      endpoint: "https://gw.example.com/revenium",
    });
  });

  it("exits without writing configuration when the endpoint processes no events", async () => {
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 0,
    });

    await expect(setupCommand(options)).rejects.toBeInstanceOf(ExitError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("exits without writing configuration when the gateway refuses the key", async () => {
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: false,
      statusCode: 403,
      message: "OTLP request failed: 403 Forbidden",
    });

    await expect(setupCommand(options)).rejects.toBeInstanceOf(ExitError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint and a malformed email before the key is sent", async () => {
    await expect(
      setupCommand({ ...options, endpoint: "http://[::1]:18962", email: "not-an-email" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("never reports a successful setup when no event was processed", async () => {
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 0,
    });

    await expect(setupCommand(options)).rejects.toBeInstanceOf(ExitError);
    expect(logged.join("\n")).not.toContain("Setup complete!");
  });
});

describe("setupCommand shell profile block", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("installs a gemini wrapper calling the launcher instead of sourcing the env file", async () => {
    await setupCommand({ ...options, skipShellUpdate: false });

    const { getSourceCommand } = vi.mocked(updateShellProfile).mock.calls[0][0];

    expect(getSourceCommand("zsh", "/tmp/.gemini/revenium.env")).toContain(
      "revenium-gemini run --",
    );
    expect(getSourceCommand("zsh", "/tmp/.gemini/revenium.env")).not.toContain("source");
  });

  it("installs a fish function calling the launcher", async () => {
    await setupCommand({ ...options, skipShellUpdate: false });

    const { getSourceCommand } = vi.mocked(updateShellProfile).mock.calls[0][0];

    expect(getSourceCommand("fish", "/tmp/.gemini/revenium.env")).toContain(
      "function gemini\n    revenium-gemini run -- $argv\nend",
    );
  });

  it("asks the updater to strip stale blocks from the other shell profiles", async () => {
    await setupCommand({ ...options, skipShellUpdate: false });

    expect(vi.mocked(updateShellProfile).mock.calls[0][0].pruneOtherProfiles).toBe(true);
  });
});

describe("setupCommand closing instructions", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("promises the wrapper only when the shell profile was updated", async () => {
    await setupCommand({ ...options, skipShellUpdate: false });

    expect(logged.join("\n")).toContain("Restart your terminal");
  });

  it("points at the launcher when the wrapper was not installed", async () => {
    await setupCommand({ ...options, skipShellUpdate: true });

    const output = logged.join("\n");
    expect(output).toContain("revenium-gemini run --");
    expect(output).not.toContain("Restart your terminal");
  });

  it("points at the launcher when the shell profile update failed", async () => {
    vi.mocked(updateShellProfile).mockResolvedValueOnce({
      success: false,
      shellType: "unknown",
      message: "Could not detect shell type.",
    });

    await setupCommand({ ...options, skipShellUpdate: false });

    const output = logged.join("\n");
    expect(output).toContain("revenium-gemini run --");
    expect(output).not.toContain("Restart your terminal");
  });
});

describe("setupCommand key scope", () => {
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
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stops a read key before any request reaches the endpoint", async () => {
    await expect(
      setupCommand({ ...options, apiKey: "rev_rk_TENANT1_0123456789abcdef" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("stops a key with an unknown scope supplied as a flag", async () => {
    await expect(
      setupCommand({ ...options, apiKey: "rev_zz_TENANT1_0123456789abcdef" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("warns about a write key and still completes setup", async () => {
    await setupCommand({ ...options, apiKey: "rev_sk_TENANT1_0123456789abcdef" });

    expect(logged.join("\n")).toContain("write key");
    expect(writeConfig).toHaveBeenCalled();
  });

  it("prints no scope warning for a metering key", async () => {
    await setupCommand({ ...options, apiKey: "rev_mk_TENANT1_0123456789abcdef" });

    expect(logged.join("\n")).not.toContain("write key");
  });

  it("stops a malformed legacy key supplied as a flag", async () => {
    await expect(setupCommand({ ...options, apiKey: "hak_short" })).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint typed at the prompt and keeps loopback working", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      apiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
    } as never);

    await setupCommand({ skipShellUpdate: true });

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
      apiKey: "rev_mk_TENANT1_0123456789abcdef",
    } as never);

    await setupCommand({ endpoint: "https://api.revenium.ai", skipShellUpdate: true });

    const apiKeyQuestion = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "apiKey") as {
      message: string;
    };

    expect(apiKeyQuestion.message).toContain("rev_mk_");
  });
});

describe("setupCommand scripted run without a terminal", () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    vi.mocked(checkEndpointHealth).mockResolvedValue({
      healthy: true,
      message: "ok",
      processedEvents: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("writes configuration without prompting when there is no TTY", async () => {
    await setupCommand({ apiKey: options.apiKey, skipShellUpdate: true });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0]).toMatchObject({
      apiKey: options.apiKey,
      endpoint: "https://api.revenium.ai",
    });
  });

  it("fails with the missing flag and never writes", async () => {
    await expect(setupCommand({ skipShellUpdate: true })).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--api-key");
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty optional value", async () => {
    await setupCommand({ apiKey: options.apiKey, organizationName: "", skipShellUpdate: true });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(vi.mocked(writeConfig).mock.calls[0][0].organizationName).toBeUndefined();
  });

  it("still prompts interactively", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({ apiKey: options.apiKey } as never);

    await setupCommand({ skipShellUpdate: true });

    expect(inquirer.prompt).toHaveBeenCalled();
  });
});
