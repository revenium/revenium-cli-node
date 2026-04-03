import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { escapeDoubleQuotedShellValue } from "../../src/_core/shell/escaping.js";
import { getFullOtlpEndpoint } from "../../src/_core/config/loader.js";

const apiKey = process.env.REVENIUM_E2E_API_KEY;
const baseEndpoint = process.env.REVENIUM_E2E_ENDPOINT || "https://api.revenium.ai";
const provider = process.env.REVENIUM_E2E_PROVIDER ?? "all";
const dist = resolve("dist");

function shouldSkip(name: string): boolean {
  if (!apiKey) return true;
  return provider !== "all" && provider !== name;
}

function runCli(entrypoint: string, command: string, tempHome: string): string {
  return execFileSync(process.execPath, [join(dist, entrypoint), command], {
    encoding: "utf-8",
    timeout: 60000,
    env: { ...process.env, HOME: tempHome, NODE_ENV: "production", NODE_OPTIONS: "" },
  });
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

  beforeAll(() => {
    tempHome = createTempHome();
    const claudeDir = join(tempHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const otlpEndpoint = `${getFullOtlpEndpoint(baseEndpoint)}/v1/logs`;
    writeFileSync(
      join(claudeDir, "revenium.env"),
      [
        `export CLAUDE_CODE_ENABLE_TELEMETRY=1`,
        `export OTEL_EXPORTER_OTLP_ENDPOINT=${escapeDoubleQuotedShellValue(otlpEndpoint)}`,
        `export OTEL_EXPORTER_OTLP_HEADERS=${escapeDoubleQuotedShellValue(`x-api-key=${apiKey}`)}`,
        `export OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
        `export OTEL_LOGS_EXPORTER=otlp`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("claude-code/cli/index.js", "test", tempHome);
    assertSuccess(output);
  });
});

describe.skipIf(shouldSkip("gemini-cli"))("gemini-cli e2e", () => {
  let tempHome: string;

  beforeAll(() => {
    tempHome = createTempHome();
    const geminiDir = join(tempHome, ".gemini");
    mkdirSync(geminiDir, { recursive: true });

    const otlpEndpoint = getFullOtlpEndpoint(baseEndpoint);
    const resourceAttrs = `revenium.api_key=${apiKey},cost_multiplier=1.0`;
    writeFileSync(
      join(geminiDir, "revenium.env"),
      [
        `export GEMINI_TELEMETRY_ENABLED=true`,
        `export GEMINI_TELEMETRY_TARGET=local`,
        `export GEMINI_TELEMETRY_OTLP_ENDPOINT=${escapeDoubleQuotedShellValue(otlpEndpoint)}`,
        `export GEMINI_TELEMETRY_OTLP_PROTOCOL=http`,
        `export GEMINI_TELEMETRY_LOG_PROMPTS=true`,
        `export OTEL_RESOURCE_ATTRIBUTES=${escapeDoubleQuotedShellValue(resourceAttrs)}`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("gemini-cli/cli/index.js", "test", tempHome);
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
        `CURSOR_API_KEY=e2e-placeholder`,
        `REVENIUM_API_KEY=${apiKey}`,
        `REVENIUM_ENDPOINT=${baseEndpoint}`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("sends test metric and reports success", () => {
    const output = runCli("cursor/cli/index.js", "test", tempHome);
    assertSuccess(output);
  });
});
