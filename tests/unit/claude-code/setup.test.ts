import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir };
});

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 12 }),
}));

import { setupCommand } from "../../../src/claude-code/commands/setup.js";
import { checkEndpointHealth } from "../../../src/_core/api/health-check.js";
import inquirer from "inquirer";
import { stubTty, restoreTty } from "../../helpers/tty.js";

const API_KEY = "hak_setupkey_0123456789";
const READ_KEY = "rev_rk_FAKEORG_0123456789abcdef";
const WRITE_KEY = "rev_sk_FAKEORG_0123456789abcdef";

const LEGACY_BLOCK = [
  "# >>> revenium-claude-code-metering >>>",
  'if [ -f "$HOME/.claude/revenium.env" ]; then',
  '    source "$HOME/.claude/revenium.env"',
  "fi",
  "# <<< revenium-claude-code-metering <<<",
].join("\n");

let home = "";

async function readProfile(): Promise<string> {
  return readFile(join(home, ".zshrc"), "utf-8");
}

beforeEach(async () => {
  vi.clearAllMocks();
  stubTty(false);
  home = await mkdtemp(join(tmpdir(), "claude-setup-"));
  homeState.dir = home;
  vi.stubEnv("SHELL", "/bin/zsh");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  vi.stubEnv("REVENIUM_CONFIG_PATH", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  restoreTty();
  homeState.dir = "";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("claude-code setupCommand — the key reaches Claude Code only", () => {
  it("writes the telemetry variables into Claude Code's own settings", async () => {
    await setupCommand({ apiKey: API_KEY, endpoint: "https://api.revenium.ai" });

    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`x-api-key=${API_KEY}`);
    expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  });

  it("leaves no key and no source line in the shell profile", async () => {
    await writeFile(join(home, ".zshrc"), "export PATH=$PATH\n");

    await setupCommand({ apiKey: API_KEY, endpoint: "https://api.revenium.ai" });

    const profile = await readProfile();
    expect(profile).not.toContain(API_KEY);
    expect(profile).not.toContain("revenium.env");
    expect(profile).toContain("export PATH=$PATH");
  });

  it("removes the block an earlier install left in the shell profile", async () => {
    await writeFile(join(home, ".zshrc"), `export PATH=$PATH\n${LEGACY_BLOCK}\n`);

    await setupCommand({ apiKey: API_KEY, endpoint: "https://api.revenium.ai" });

    expect(await readProfile()).not.toContain("revenium-claude-code-metering");
  });

  it("writes a config file the shell cannot export from", async () => {
    await setupCommand({ apiKey: API_KEY, endpoint: "https://api.revenium.ai" });

    expect(await readFile(join(home, ".claude", "revenium.env"), "utf-8")).not.toContain("export ");
  });
});

describe("claude-code setupCommand — key scope", () => {
  it("stops a read key before any request reaches the endpoint", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      setupCommand({ apiKey: READ_KEY, endpoint: "https://api.revenium.ai" }),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(checkEndpointHealth).not.toHaveBeenCalled();
  });

  it("warns about a write key and still completes setup", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await setupCommand({ apiKey: WRITE_KEY, endpoint: "https://api.revenium.ai" });

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("write key");
    expect(output).toContain("rev_mk_");
    expect(await readFile(join(home, ".claude", "revenium.env"), "utf-8")).toContain(WRITE_KEY);
  });

  it("asks for a metering key in the interactive prompt", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({
      apiKey: "rev_mk_FAKEORG_0123456789abcdef",
    } as never);

    await setupCommand({ endpoint: "https://api.revenium.ai" });

    const apiKeyQuestion = vi
      .mocked(inquirer.prompt)
      .mock.calls.flatMap(([questions]) => (Array.isArray(questions) ? questions : []))
      .find((question) => (question as { name?: string }).name === "apiKey") as {
      message: string;
    };

    expect(apiKeyQuestion.message).toContain("rev_mk_");
  });

  it("prints nothing extra for a metering key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await setupCommand({
      apiKey: "rev_mk_FAKEORG_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
    });

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).not.toContain("rev_mk_");
  });

  it("stops a management endpoint that would carry the key over plain http", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      setupCommand({
        apiKey: API_KEY,
        endpoint: "https://api.revenium.ai",
        managementEndpoint: "http://internal.example/profitstream",
      }),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(checkEndpointHealth).not.toHaveBeenCalled();
  });

  it("stops a malformed legacy key given as a flag", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      setupCommand({ apiKey: "hak_short", endpoint: "https://api.revenium.ai" }),
    ).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(checkEndpointHealth).not.toHaveBeenCalled();
  });
});

describe("claude-code setupCommand — scripted run without a terminal", () => {
  it("writes configuration without prompting when there is no TTY", async () => {
    await setupCommand({ apiKey: API_KEY });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(await readFile(join(home, ".claude", "revenium.env"), "utf-8")).toContain(API_KEY);
  });

  it("defaults the endpoint without a TTY and without --endpoint", async () => {
    await setupCommand({ apiKey: API_KEY });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(checkEndpointHealth).toHaveBeenCalledWith(
      "https://api.revenium.ai",
      API_KEY,
      "claude-code",
    );
  });

  it("fails with the missing flag and never writes", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(setupCommand({})).rejects.toThrow("process.exit");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toContain("--api-key");
    expect(checkEndpointHealth).not.toHaveBeenCalled();
    await expect(readFile(join(home, ".claude", "revenium.env"), "utf-8")).rejects.toThrow();
  });

  it("accepts an explicitly empty optional value", async () => {
    await setupCommand({ apiKey: API_KEY, email: "" });

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(await readFile(join(home, ".claude", "revenium.env"), "utf-8")).not.toContain(
      "SUBSCRIBER_EMAIL",
    );
  });

  it("still prompts interactively", async () => {
    stubTty(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({ apiKey: API_KEY } as never);

    await setupCommand({});

    expect(inquirer.prompt).toHaveBeenCalled();
  });

  it("rejects an empty key in a terminal instead of crashing", async () => {
    stubTty(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(setupCommand({ apiKey: "" })).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(checkEndpointHealth).not.toHaveBeenCalled();
  });

  it("refuses a plain-http endpoint and a malformed email before the key is sent", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      setupCommand({
        apiKey: API_KEY,
        endpoint: "http://[::1]:18962",
        email: "not-an-email",
      }),
    ).rejects.toThrow("process.exit");

    expect(checkEndpointHealth).not.toHaveBeenCalled();
  });
});
