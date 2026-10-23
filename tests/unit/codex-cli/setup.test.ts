import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spinnerFailures = vi.hoisted(() => [] as string[]);

vi.mock("ora", () => ({
  default: () => {
    const spinner = {
      text: "",
      start: () => spinner,
      succeed: () => spinner,
      fail: (message: string) => {
        spinnerFailures.push(message);
        return spinner;
      },
      stop: () => spinner,
      warn: () => spinner,
    };
    return spinner;
  },
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkPayloadDelivery: vi.fn(),
  generateTestSessionId: vi.fn().mockReturnValue("test-session"),
}));

vi.mock("../../../src/codex-cli/config/loader.js", () => ({
  readCodexToml: vi.fn().mockResolvedValue(null),
  hasOtelSection: vi.fn().mockReturnValue(false),
  getCodexConfigPath: vi.fn().mockReturnValue("/tmp/.codex/config.toml"),
  getReveniumEnvPath: vi.fn().mockReturnValue("/tmp/.codex/revenium.env"),
  isLegacyFlatKeyForm: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/codex-cli/config/writer.js", async (importOriginal) => ({
  resolveBaseEndpoint: (
    await importOriginal<typeof import("../../../src/codex-cli/config/writer.js")>()
  ).resolveBaseEndpoint,
  generateTomlBlock: vi
    .fn()
    .mockReturnValue(
      '[otel]\nexporter = { otlp-http = { endpoint = "https://api.revenium.ai/meter/v2/otlp/v1/logs", protocol = "json", headers = { "x-api-key" = "hak_test" } } }\nmetrics_exporter = "none"\n\n[features]\nruntime_metrics = true\n',
    ),
  writeCodexToml: vi
    .fn()
    .mockResolvedValue({ configPath: "/tmp/.codex/config.toml", backupPath: null }),
  writeReveniumEnv: vi.fn().mockResolvedValue("/tmp/.codex/revenium.env"),
  getReveniumEnvPath: vi.fn().mockReturnValue("/tmp/.codex/revenium.env"),
  generateEnvContent: vi.fn().mockReturnValue("return 0 2>/dev/null\n"),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  updateShellProfile: vi.fn().mockResolvedValue({ success: true, message: "Profile updated" }),
  getManualInstructions: vi.fn().mockReturnValue("Add the wrapper to your shell profile"),
}));

vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      email: "",
    }),
  },
}));

import { setupAction } from "../../../src/codex-cli/commands/setup.js";
import { program } from "../../../src/codex-cli/cli/index.js";
import * as loaderModule from "../../../src/codex-cli/config/loader.js";
import * as profileUpdater from "../../../src/_core/shell/profile-updater.js";
import * as writerModule from "../../../src/codex-cli/config/writer.js";
import { checkPayloadDelivery } from "../../../src/_core/api/health-check.js";
import { DEFAULT_REVENIUM_URL } from "../../../src/_core/constants.js";
import { SHELL_PROFILE_MARKER } from "../../../src/codex-cli/constants.js";
import inquirerPkg from "inquirer";
import { stubTty, restoreTty } from "../../helpers/tty.js";

class ExitError extends Error {}

beforeEach(() => {
  stubTty(false);
  vi.mocked(checkPayloadDelivery).mockResolvedValue({
    healthy: true,
    statusCode: 200,
    message: "ok",
    latencyMs: 12,
    processedEvents: 1,
  });
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
});

afterEach(() => {
  restoreTty();
});

describe("setupAction — shell profile handover", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("installs the codex wrapper that carries attribution into live sessions", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
    });

    expect(profileUpdater.updateShellProfile).toHaveBeenCalledWith(
      expect.objectContaining({ markerName: SHELL_PROFILE_MARKER, pruneOtherProfiles: true }),
    );
  });

  it("leaves the shell profile alone when the wrapper install is opted out", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      skipShellUpdate: true,
    });

    expect(profileUpdater.updateShellProfile).not.toHaveBeenCalled();
  });

  it("names the wrapper as the only path organization and product take to a live session", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });

    await setupAction({
      apiKey: "hak_test_key123",
      organizationName: "Acme, Inc.",
    });

    expect(logs.join("\n")).toContain("`codex` wrapper");
  });

  it("tells the developer how to launch Codex when the profile could not be updated", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    vi.mocked(profileUpdater.updateShellProfile).mockResolvedValueOnce({
      success: false,
      shellType: "unknown",
      message: "Could not detect shell type.",
    });

    await setupAction({ apiKey: "hak_test_key123", productName: "R=D 100%" });

    expect(logs.join("\n")).toContain("revenium-codex run --");
  });

  it("installs a wrapper that reads the attribution written beside a custom config path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await setupAction({
      apiKey: "hak_test_key123",
      organizationName: "Acme, Inc.",
      configPath: "/custom/config.toml",
    });

    const [config] = vi.mocked(profileUpdater.updateShellProfile).mock.calls[0];
    expect(config.getSourceCommand("bash", config.getConfigFilePath())).toContain(
      "revenium-codex run --config-path '/custom/config.toml' --",
    );
  });

  it("installs a wrapper with no path argument when setup used the default config", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await setupAction({ apiKey: "hak_test_key123", organizationName: "Acme, Inc." });

    const [config] = vi.mocked(profileUpdater.updateShellProfile).mock.calls[0];
    expect(config.getSourceCommand("bash", config.getConfigFilePath())).toContain(
      "revenium-codex run --",
    );
  });
});

describe("setupAction — --force bypasses overwrite prompt", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      '[otel]\nendpoint = "https://api.revenium.ai"\n',
    );
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("does not prompt for overwrite confirmation when --force is set", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      force: true,
    });

    const promptCalls = vi.mocked(inquirerPkg.prompt).mock.calls;
    const hasOverwriteQuestion = promptCalls.some((call) => {
      const questions = call[0] as Array<{ name: string }>;
      return Array.isArray(questions) && questions.some((q) => q.name === "overwrite");
    });

    expect(hasOverwriteQuestion).toBe(false);
  });

  it("proceeds to write config without user input when --force is set", async () => {
    const writerModule = await import("../../../src/codex-cli/config/writer.js");

    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      force: true,
    });

    expect(writerModule.writeCodexToml).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("setupAction — connectivity gate", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    spinnerFailures.length = 0;
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError("exit");
    }) as never);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exits without writing configuration when the gateway refuses the key", async () => {
    vi.mocked(checkPayloadDelivery).mockResolvedValue({
      healthy: false,
      statusCode: 403,
      message: "OTLP request failed: 403 Forbidden",
    });

    await expect(
      setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
    expect(writerModule.writeReveniumEnv).not.toHaveBeenCalled();
    expect(logged.some((line) => line.includes("Setup complete!"))).toBe(false);
  });

  it("reports the refusal with the wording the other setups use", async () => {
    vi.mocked(checkPayloadDelivery).mockResolvedValue({
      healthy: false,
      statusCode: 403,
      message: "OTLP request failed: 403 Forbidden",
    });

    await expect(
      setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(spinnerFailures).toContain(
      "API key validation failed: OTLP request failed: 403 Forbidden",
    );
  });

  it("refuses a plain-http endpoint and a malformed email before the key is sent", async () => {
    await expect(
      setupAction({
        apiKey: "hak_test_key123",
        endpoint: "http://[::1]:18962",
        email: "not-an-email",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkPayloadDelivery).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
    expect(writerModule.writeReveniumEnv).not.toHaveBeenCalled();
  });

  it("exits without writing configuration when the endpoint is unreachable", async () => {
    vi.mocked(checkPayloadDelivery).mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    await expect(
      setupAction({ apiKey: "hak_test_key123", endpoint: "https://no-such-host.invalid" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
    expect(writerModule.writeReveniumEnv).not.toHaveBeenCalled();
    expect(logged.some((line) => line.includes("Setup complete!"))).toBe(false);
  });

  it("exits without writing configuration when the backend accepted no events", async () => {
    vi.mocked(checkPayloadDelivery).mockResolvedValue({
      healthy: false,
      statusCode: 200,
      message: "The endpoint accepted the request but processed 0 event(s) and rejected 1.",
      processedEvents: 0,
    });

    await expect(
      setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
    expect(logged.some((line) => line.includes("Setup complete!"))).toBe(false);
  });

  it("sends one connectivity check against the resolved endpoint before writing", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://stub.example/meter/v2/otlp/v1/logs",
    });

    expect(checkPayloadDelivery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkPayloadDelivery).mock.calls[0][0]).toBe("https://stub.example");
    expect(vi.mocked(checkPayloadDelivery).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(writerModule.writeCodexToml).mock.invocationCallOrder[0],
    );
  });

  it("checks the same URL the writer persists when the gateway prefix ends in /meter", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://gateway.example/proxy/meter/meter/v2/otlp/v1/logs",
    });

    const checkedEndpoint = vi.mocked(checkPayloadDelivery).mock.calls[0][0];
    const writtenConfig = vi.mocked(writerModule.generateTomlBlock).mock.calls[0][0];

    expect(checkedEndpoint).toBe("https://gateway.example/proxy/meter");
    expect(writerModule.resolveBaseEndpoint(writtenConfig)).toBe(checkedEndpoint);
  });
});

describe("setupAction — endpoint prompt", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function endpointQuestion() {
    const questions = vi.mocked(inquirerPkg.prompt).mock.calls.at(-1)?.[0] as Array<{
      name: string;
      when?: boolean;
      default?: string;
      validate?: (input: string) => true | string;
    }>;
    return questions.find((question) => question.name === "endpoint");
  }

  it("asks for the endpoint, offering the default, when the command line carries none", async () => {
    stubTty(true);

    await program.parseAsync(["setup", "--api-key", "hak_test_key123"], { from: "user" });

    expect(endpointQuestion()?.when).toBe(true);
    expect(endpointQuestion()?.default).toBe(DEFAULT_REVENIUM_URL);
  });

  it("asks nothing at all when the session is not interactive", async () => {
    stubTty(false);

    await setupAction({ apiKey: "hak_test_key123" });

    expect(inquirerPkg.prompt).not.toHaveBeenCalled();
  });

  it("rejects an endpoint that is not a valid URL", async () => {
    stubTty(true);

    await setupAction({ apiKey: "hak_test_key123" });

    expect(endpointQuestion()?.validate?.("not-a-url")).not.toBe(true);
    expect(endpointQuestion()?.validate?.(DEFAULT_REVENIUM_URL)).toBe(true);
  });
});

describe("setupAction — tool-detail opt-out reaches the written files", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function configsWrittenFor(options: Parameters<typeof setupAction>[0]) {
    const writerModule = await import("../../../src/codex-cli/config/writer.js");
    await setupAction(options);
    return {
      toml: vi.mocked(writerModule.generateTomlBlock).mock.calls[0][0],
      env: vi.mocked(writerModule.writeReveniumEnv).mock.calls[0][0],
    };
  }

  it("carries the opt-out into both the config.toml block and the environment file", async () => {
    const written = await configsWrittenFor({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      logToolDetails: false,
    });

    expect(written.toml.logToolDetails).toBe(false);
    expect(written.env.logToolDetails).toBe(false);
  });

  it("leaves live export untouched when the flag is not passed", async () => {
    const written = await configsWrittenFor({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
    });

    expect(written.toml.logToolDetails).toBeUndefined();
    expect(written.env.logToolDetails).toBeUndefined();
  });
});

describe("setupAction — non-TTY without --force", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      '[otel]\nendpoint = "https://api.revenium.ai"\n',
    );
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exits non-zero when [otel] already exists and running non-TTY without --force", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not prompt the user when running non-TTY without --force", async () => {
    vi.mocked(inquirerPkg.prompt).mockClear();

    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
    });

    const promptCalls = vi.mocked(inquirerPkg.prompt).mock.calls;
    const hasOverwriteQuestion = promptCalls.some((call) => {
      const questions = call[0] as Array<{ name: string }>;
      return Array.isArray(questions) && questions.some((q) => q.name === "overwrite");
    });
    expect(hasOverwriteQuestion).toBe(false);
  });
});

describe("setupAction — key scope", () => {
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
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stops a read key before any request reaches the endpoint", async () => {
    await expect(
      setupAction({ apiKey: "rev_rk_TENANT1_0123456789abcdef", endpoint: DEFAULT_REVENIUM_URL }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkPayloadDelivery).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
  });

  it("stops a key with an unknown scope before any request reaches the endpoint", async () => {
    await expect(
      setupAction({ apiKey: "rev_zz_TENANT1_0123456789abcdef", endpoint: DEFAULT_REVENIUM_URL }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(checkPayloadDelivery).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
  });

  it("warns about a write key and still completes setup", async () => {
    await setupAction({
      apiKey: "rev_sk_TENANT1_0123456789abcdef",
      endpoint: DEFAULT_REVENIUM_URL,
    });

    expect(logged.join("\n")).toContain("write key");
    expect(writerModule.writeCodexToml).toHaveBeenCalled();
  });

  it("prints no scope warning for a metering key", async () => {
    await setupAction({
      apiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: DEFAULT_REVENIUM_URL,
    });

    expect(logged.join("\n")).not.toContain("write key");
  });

  it("asks for a metering key in the interactive prompt", async () => {
    stubTty(true);
    vi.mocked(inquirerPkg.prompt).mockResolvedValue({
      apiKey: "rev_mk_TENANT1_0123456789abcdef",
      endpoint: DEFAULT_REVENIUM_URL,
      email: "",
    } as never);

    await setupAction({ endpoint: DEFAULT_REVENIUM_URL });

    const apiKeyQuestion = vi
      .mocked(inquirerPkg.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "apiKey") as {
      message: string;
    };

    expect(apiKeyQuestion.message).toContain("rev_mk_");
  });
});

describe("setupAction — scripted run without a terminal", () => {
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
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("writes configuration without prompting when there is no TTY", async () => {
    await setupAction({ apiKey: "hak_test_key123" });

    expect(inquirerPkg.prompt).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).toHaveBeenCalled();
    expect(writerModule.writeReveniumEnv).toHaveBeenCalled();
  });

  it("fails with the missing flag and never writes", async () => {
    await expect(setupAction({})).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--api-key");
    expect(checkPayloadDelivery).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
    expect(writerModule.writeReveniumEnv).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty optional value", async () => {
    await setupAction({ apiKey: "hak_test_key123", organizationName: "" });

    expect(inquirerPkg.prompt).not.toHaveBeenCalled();
    expect(
      vi.mocked(writerModule.generateTomlBlock).mock.calls[0][0].organizationName,
    ).toBeUndefined();
  });

  it("stores attribution values and email without surrounding whitespace", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      email: " user@example.com ",
      organizationName: "  Acme  ",
      productName: "  Metering  ",
    });

    const written = vi.mocked(writerModule.generateTomlBlock).mock.calls[0][0];
    expect(written.email).toBe("user@example.com");
    expect(written.organizationName).toBe("Acme");
    expect(written.productName).toBe("Metering");
  });

  it("refuses a bad flag before asking about an existing otel section", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue('[otel]\nendpoint = "x"\n');

    await expect(
      setupAction({ apiKey: "hak_test_key123", endpoint: "http://internal.example" }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(inquirerPkg.prompt).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Endpoint must use HTTPS (except for localhost)");
  });

  it("keeps refusing an existing otel section without --force", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue('[otel]\nendpoint = "x"\n');
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(true);

    await expect(setupAction({ apiKey: "hak_test_key123" })).rejects.toBeInstanceOf(ExitError);

    expect(errors.join("\n")).toContain("--force");
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
  });

  it("still prompts interactively", async () => {
    stubTty(true);

    await setupAction({});

    expect(inquirerPkg.prompt).toHaveBeenCalled();
  });
});

describe("setupAction — otel layouts that used to be silently overwritten", () => {
  const layouts = {
    "nested exporter sub-table": {
      toml: '[otel.trace_exporter.otlp-http]\nendpoint = "https://collector.customer.example/v1/traces"\n',
      name: "otel.trace_exporter.otlp-http",
    },
    "indented [otel] header": {
      toml: '  [otel]\nexporter = { otlp-http = { endpoint = "https://collector.customer.example" } }\n',
      name: "otel",
    },
    "root-level dotted key": {
      toml: 'otel.exporter = { otlp-http = { endpoint = "https://collector.customer.example" } }\n',
      name: "otel.exporter",
    },
    "plain [otel] header": {
      toml: '[otel]\nendpoint = "https://collector.customer.example"\n',
      name: "otel",
    },
  };

  let errors: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  for (const [layout, layoutCase] of Object.entries(layouts)) {
    it(`refuses to overwrite a ${layout} and names it`, async () => {
      vi.mocked(loaderModule.readCodexToml).mockResolvedValue(layoutCase.toml);

      await setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain(layoutCase.name);
      expect(errors.join("\n")).toContain("--force");
    });
  }

  it("writes without prompting when the only otel key belongs to another table", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      '[model]\nname = "gpt-5"\n\n[profiles.foo]\notel.endpoint = "https://collector.customer.example"\n',
    );

    await setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(inquirerPkg.prompt).not.toHaveBeenCalled();
    expect(writerModule.writeCodexToml).toHaveBeenCalled();
  });
});

describe("setupAction — interactive confirmation for an existing otel config", () => {
  beforeEach(() => {
    stubTty(true);
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      '[otel.trace_exporter.otlp-http]\nendpoint = "https://collector.customer.example/v1/traces"\n',
    );
    vi.mocked(inquirerPkg.prompt).mockResolvedValue({ overwrite: false } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("names the entry in the confirmation and writes nothing when declined", async () => {
    await setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" });

    const question = vi
      .mocked(inquirerPkg.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))[0] as {
      name: string;
      message: string;
    };

    expect(question.name).toBe("overwrite");
    expect(question.message).toContain("otel.trace_exporter.otlp-http");
    expect(question.message).toContain("line 1");
    expect(writerModule.writeCodexToml).not.toHaveBeenCalled();
  });
});

describe("setupAction — backup reporting", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue('[otel]\nendpoint = "x"\n');
  });

  afterEach(() => {
    vi.mocked(writerModule.writeCodexToml).mockResolvedValue({
      configPath: "/tmp/.codex/config.toml",
      backupPath: null,
    });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("tells the user where the overwritten config was saved", async () => {
    vi.mocked(writerModule.writeCodexToml).mockResolvedValue({
      configPath: "/tmp/.codex/config.toml",
      backupPath: "/tmp/.codex/config.toml.revenium-backup-2026-01-01T00-00-00-000Z",
    });

    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      force: true,
    });

    expect(logged.join("\n")).toContain(
      "Backed up previous config to /tmp/.codex/config.toml.revenium-backup-2026-01-01T00-00-00-000Z",
    );
  });

  it("prints no backup line when there was no previous config", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);

    await setupAction({ apiKey: "hak_test_key123", endpoint: "https://api.revenium.ai" });

    expect(logged.join("\n")).not.toContain("Backed up previous config");
  });
});
