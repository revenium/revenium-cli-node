import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/codex-cli/config/loader.js", () => ({
  readCodexToml: vi.fn().mockResolvedValue(null),
  hasOtelSection: vi.fn().mockReturnValue(false),
  getCodexConfigPath: vi.fn().mockReturnValue("/tmp/.codex/config.toml"),
  isLegacyFlatKeyForm: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/codex-cli/config/writer.js", () => ({
  generateTomlBlock: vi
    .fn()
    .mockReturnValue(
      '[otel]\nmetrics_exporter = "none"\n\n[otel.exporter.otlp-http]\nendpoint = "https://api.revenium.ai/v1/logs"\nprotocol = "binary"\n\n[otel.exporter.otlp-http.headers]\n"x-api-key" = "hak_test"\n\n[features]\nruntime_metrics = true\n',
    ),
  writeCodexToml: vi.fn().mockResolvedValue("/tmp/.codex/config.toml"),
  writeReveniumEnv: vi.fn().mockResolvedValue("/tmp/.codex/revenium.env"),
  getReveniumEnvPath: vi.fn().mockReturnValue("/tmp/.codex/revenium.env"),
  generateEnvContent: vi.fn().mockReturnValue("export REVENIUM_API_KEY='hak_test'\n"),
}));

vi.mock("../../../src/_core/shell/profile-updater.js", () => ({
  updateShellProfile: vi.fn().mockResolvedValue({ success: true, message: "Profile updated" }),
  getManualInstructions: vi.fn().mockReturnValue("source ~/.codex/revenium.env"),
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
import * as loaderModule from "../../../src/codex-cli/config/loader.js";
import * as profileUpdater from "../../../src/_core/shell/profile-updater.js";
import inquirerPkg from "inquirer";

describe("setupAction — --skip-shell-update", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("does not call updateShellProfile when --skip-shell-update is set", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
      skipShellUpdate: true,
    });

    expect(profileUpdater.updateShellProfile).not.toHaveBeenCalled();
  });

  it("calls updateShellProfile when --skip-shell-update is not set", async () => {
    await setupAction({
      apiKey: "hak_test_key123",
      endpoint: "https://api.revenium.ai",
    });

    expect(profileUpdater.updateShellProfile).toHaveBeenCalled();
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
      skipShellUpdate: true,
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
      skipShellUpdate: true,
      force: true,
    });

    expect(writerModule.writeCodexToml).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("setupAction — non-TTY without --force", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      '[otel]\nendpoint = "https://api.revenium.ai"\n',
    );
    vi.mocked(loaderModule.hasOtelSection).mockReturnValue(true);
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
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
