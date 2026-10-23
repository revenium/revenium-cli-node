import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { escapeShellValue } from "../../src/_core/shell/escaping.js";
import { getFullOtlpEndpoint } from "../../src/_core/config/loader.js";

const forceFailure = process.env.REVENIUM_E2E_FORCE_FAILURE === "true";
const apiKey = process.env.REVENIUM_E2E_API_KEY;
const baseEndpoint = process.env.REVENIUM_E2E_ENDPOINT || "https://api.revenium.ai";
const provider = process.env.REVENIUM_E2E_PROVIDER ?? "all";
const dist = resolve("dist");

// INTERNAL ONLY - NEVER port this block to the public repo
if (forceFailure) {
  describe("forced failure", () => {
    it("intentional failure for alert validation", () => {
      expect.fail(
        "REVENIUM_E2E_FORCE_FAILURE is enabled - this is an intentional failure to validate alerting",
      );
    });
  });
}

function shouldSkip(name: string): boolean {
  if (!apiKey) return true;
  return provider !== "all" && provider !== name;
}

function runCli(entrypoint: string, args: string[], tempHome: string): string {
  try {
    return execFileSync(process.execPath, [join(dist, entrypoint), ...args], {
      encoding: "utf-8",
      timeout: 60000,
      env: {
        ...process.env,
        HOME: tempHome,
        CLAUDE_CONFIG_DIR: join(tempHome, ".claude"),
        REVENIUM_CONFIG_PATH: "",
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
  } catch (error) {
    throw new Error(maskKey(error instanceof Error ? error.message : String(error)));
  }
}

function maskKey(message: string): string {
  return apiKey ? message.split(apiKey).join("<redacted>") : message;
}

function createTempHome(): string {
  return join(tmpdir(), `revenium-e2e-${randomBytes(4).toString("hex")}`);
}

function assertSuccess(output: string): void {
  expect(output).toContain("Integration is working correctly!");
  const match = output.match(/Processed:\s+(\d+)/);
  expect(match).not.toBeNull();
  expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(0);
  expect(output).toMatch(/ID:/);
  expect(output).toMatch(/Resource Type:/);
  expect(output).toMatch(/Created:/);
}

describe.skipIf(shouldSkip("claude-code"))("claude-code e2e", () => {
  let tempHome: string;
  let claudeDir: string;

  beforeAll(() => {
    tempHome = createTempHome();
    claudeDir = join(tempHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(tempHome, ".zshrc"), "export PATH=$PATH\n");
    writeFileSync(
      join(claudeDir, "revenium.fish"),
      `set -gx OTEL_EXPORTER_OTLP_HEADERS "x-api-key=${apiKey}"\n`,
    );

    runCli(
      "claude-code/cli/index.js",
      ["setup", "-k", apiKey!, "-e", "e2e@revenium.ai", "--endpoint", baseEndpoint],
      tempHome,
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("claude-code/cli/index.js", ["test"], tempHome);
    assertSuccess(output);
  });

  it("scopes the telemetry header to Claude Code's own settings", () => {
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`x-api-key=${apiKey}`);
  });

  it("leaves the API key out of every file the shell reads", () => {
    const envFile = readFileSync(join(claudeDir, "revenium.env"), "utf-8");
    expect(envFile).not.toContain("export ");

    const profile = readFileSync(join(tempHome, ".zshrc"), "utf-8");
    expect(profile).not.toContain(apiKey!);
    expect(profile).not.toContain("revenium.env");

    expect(existsSync(join(claudeDir, "revenium.fish"))).toBe(false);
  });

  it("keeps the key readable only by its owner", () => {
    expect(statSync(join(claudeDir, "settings.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(claudeDir, "revenium.env")).mode & 0o777).toBe(0o600);
  });

  it("never prints the full key in a verbose test payload", () => {
    const output = runCli("claude-code/cli/index.js", ["test", "--verbose"], tempHome);
    expect(output).not.toContain(apiKey!);
  });
});

describe.skipIf(shouldSkip("gemini-cli"))("gemini-cli e2e", () => {
  let tempHome: string;

  beforeAll(() => {
    tempHome = createTempHome();
    const geminiDir = join(tempHome, ".gemini");
    mkdirSync(geminiDir, { recursive: true });

    const otlpEndpoint = getFullOtlpEndpoint(baseEndpoint);
    const resourceAttrs = `revenium.api_key=${apiKey}`;
    writeFileSync(
      join(geminiDir, "revenium.env"),
      [
        `GEMINI_TELEMETRY_ENABLED=true`,
        `GEMINI_TELEMETRY_TARGET=local`,
        `GEMINI_TELEMETRY_OTLP_ENDPOINT=${escapeShellValue(otlpEndpoint)}`,
        `GEMINI_TELEMETRY_OTLP_PROTOCOL=http`,
        `GEMINI_TELEMETRY_LOG_PROMPTS=false`,
        `OTEL_RESOURCE_ATTRIBUTES=${escapeShellValue(resourceAttrs)}`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("gemini-cli/cli/index.js", ["test"], tempHome);
    assertSuccess(output);
  });
});

describe.skipIf(shouldSkip("cursor"))("cursor e2e", () => {
  let tempHome: string;

  beforeAll(() => {
    tempHome = createTempHome();
    const cursorReveniumDir = join(tempHome, ".cursor", "revenium");
    mkdirSync(cursorReveniumDir, { recursive: true });

    writeFileSync(
      join(cursorReveniumDir, "revenium.env"),
      [
        `REVENIUM_CURSOR_API_KEY=e2e-placeholder`,
        `REVENIUM_API_KEY=${apiKey}`,
        `REVENIUM_ENDPOINT=${baseEndpoint}`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("cursor/cli/index.js", ["test"], tempHome);
    assertSuccess(output);
  });
});

describe.skipIf(shouldSkip("codex"))("codex e2e", () => {
  let tempHome: string;
  let codexDir: string;

  beforeAll(() => {
    tempHome = createTempHome();
    codexDir = join(tempHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(tempHome, ".zshrc"), "export PATH=$PATH\n");

    runCli(
      "codex-cli/cli/index.js",
      ["setup", "-k", apiKey!, "-e", "e2e@revenium.ai", "--endpoint", baseEndpoint, "--force"],
      tempHome,
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("codex-cli/cli/index.js", ["test"], tempHome);
    assertSuccess(output);
  });

  it("leaves the API key out of every file the shell reads", () => {
    const envFile = readFileSync(join(codexDir, "revenium.env"), "utf-8");
    expect(envFile).not.toContain("export ");
    expect(envFile).not.toContain(apiKey!);

    const profile = readFileSync(join(tempHome, ".zshrc"), "utf-8");
    expect(profile).not.toContain(apiKey!);
    expect(profile).not.toContain("revenium.env");
  });
});
