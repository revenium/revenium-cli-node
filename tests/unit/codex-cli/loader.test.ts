import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractOtelValues,
  getCodexConfigPath,
  getCodexHome,
  getCodexSessionsPath,
  getReveniumEnvPath,
  hasDisabledExporter,
  hasOtelSection,
  resolveOtelCredentials,
} from "../../../src/codex-cli/config/loader.js";
import { DEFAULT_REVENIUM_URL } from "../../../src/_core/constants.js";

describe("extractOtelValues", () => {
  it("normalizes legacy [otel] endpoint with /v1/logs suffix", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai/v1/logs"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("normalizes legacy [otel] endpoint with trailing slash", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai/v1/logs/"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("returns clean base endpoint when legacy [otel] has no suffix", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("returns null when [otel] section is missing", () => {
    const toml = `
[features]
runtime_metrics = true
`;
    expect(extractOtelValues(toml)).toBeNull();
  });

  it("returns null when [otel] has endpoint but no api_key", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai"
`;
    expect(extractOtelValues(toml)).toBeNull();
  });
});

describe("section readers agree with hasOtelSection on what a header is", () => {
  const indented =
    '  [otel]\nendpoint = "https://api.revenium.ai/v1/logs"\napi_key = "hak_test_key"\n';

  it("reads values under an indented header it also reports as an otel section", () => {
    expect(hasOtelSection(indented)).toBe(true);
    expect(extractOtelValues(indented)).toEqual({
      endpoint: "https://api.revenium.ai",
      apiKey: "hak_test_key",
    });
  });

  it("reads the exporter opt-out under a quoted header", () => {
    expect(hasDisabledExporter('["otel"]\nexporter = "none"\n')).toBe(true);
  });

  it("ignores a header that only appears inside a multi-line string", () => {
    const toml = 'developer_instructions = """\n[otel]\nexporter = "none"\n"""\n';

    expect(hasOtelSection(toml)).toBe(false);
    expect(hasDisabledExporter(toml)).toBe(false);
  });
});

describe("hasDisabledExporter", () => {
  const withOtel = (line: string) => `[otel]\n${line}\nmetrics_exporter = "none"\n`;

  it("detects the opt-out written by setup --no-log-tool-details", () => {
    expect(hasDisabledExporter(withOtel('exporter = "none"'))).toBe(true);
  });

  it("detects the opt-out when the line carries a trailing comment", () => {
    expect(hasDisabledExporter(withOtel('exporter = "none" # revenium opt-out'))).toBe(true);
  });

  it("detects the opt-out written with single quotes", () => {
    expect(hasDisabledExporter(withOtel("exporter = 'none'"))).toBe(true);
  });

  it("returns false when an OTLP exporter is configured", () => {
    expect(
      hasDisabledExporter(withOtel('exporter = { otlp-http = { endpoint = "https://x" } }')),
    ).toBe(false);
  });

  it("returns false when there is no [otel] section", () => {
    expect(hasDisabledExporter("[features]\nruntime_metrics = true\n")).toBe(false);
  });
});

describe("resolveOtelCredentials", () => {
  let tempDir: string;
  const configPath = () => join(tempDir, "config.toml");

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-credentials-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeEnvFile(content: string): void {
    writeFileSync(join(tempDir, "revenium.env"), content);
  }

  it("prefers the credentials carried by the [otel] exporter", async () => {
    writeEnvFile("REVENIUM_API_KEY='hak_from_env'\n");
    const toml = '[otel]\nendpoint = "https://api.revenium.ai"\napi_key = "hak_from_toml"\n';

    await expect(resolveOtelCredentials(toml, configPath())).resolves.toEqual({
      endpoint: "https://api.revenium.ai",
      apiKey: "hak_from_toml",
    });
  });

  it("falls back to the environment file when the exporter is disabled", async () => {
    writeEnvFile(
      "return 0 2>/dev/null\nREVENIUM_API_KEY='hak_from_env'\nREVENIUM_ENDPOINT='https://api.revenium.ai'\n",
    );

    await expect(
      resolveOtelCredentials('[otel]\nexporter = "none"\n', configPath()),
    ).resolves.toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_from_env" });
  });

  it("defaults the endpoint when the environment file only carries a key", async () => {
    writeEnvFile("REVENIUM_API_KEY='hak_from_env'\n");

    const result = await resolveOtelCredentials('[otel]\nexporter = "none"\n', configPath());

    expect(result?.endpoint).toBe(DEFAULT_REVENIUM_URL);
  });

  it("returns null when neither source carries a key", async () => {
    await expect(
      resolveOtelCredentials('[otel]\nexporter = "none"\n', configPath()),
    ).resolves.toBeNull();
  });
});

describe("Codex paths follow CODEX_HOME", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves config, environment file and sessions under ~/.codex when CODEX_HOME is unset", () => {
    vi.stubEnv("CODEX_HOME", undefined);
    const codexHome = join(homedir(), ".codex");

    expect(getCodexHome()).toBe(codexHome);
    expect(getCodexConfigPath()).toBe(join(codexHome, "config.toml"));
    expect(getReveniumEnvPath()).toBe(join(codexHome, "revenium.env"));
    expect(getCodexSessionsPath()).toBe(join(codexHome, "sessions"));
  });

  it("resolves every path under CODEX_HOME when it is set", () => {
    vi.stubEnv("CODEX_HOME", "/opt/codex-home");

    expect(getCodexConfigPath()).toBe(join("/opt/codex-home", "config.toml"));
    expect(getReveniumEnvPath()).toBe(join("/opt/codex-home", "revenium.env"));
    expect(getCodexSessionsPath()).toBe(join("/opt/codex-home", "sessions"));
  });

  it("treats a whitespace-only CODEX_HOME as unset", () => {
    vi.stubEnv("CODEX_HOME", "   ");

    expect(getCodexHome()).toBe(join(homedir(), ".codex"));
  });

  it("lets --config-path beat a set CODEX_HOME, for the config and its environment file", () => {
    vi.stubEnv("CODEX_HOME", "/opt/codex-home");

    expect(getCodexConfigPath("/elsewhere/config.toml")).toBe("/elsewhere/config.toml");
    expect(getReveniumEnvPath("/elsewhere/config.toml")).toBe("/elsewhere/revenium.env");
  });

  it("lets --sessions-path beat a set CODEX_HOME", () => {
    vi.stubEnv("CODEX_HOME", "/opt/codex-home");

    expect(getCodexSessionsPath("/elsewhere/sessions")).toBe("/elsewhere/sessions");
  });
});
