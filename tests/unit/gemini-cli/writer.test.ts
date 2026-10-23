import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = { dir: "" };

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir || actual.homedir() };
});

import { generateEnvContent, writeConfig } from "../../../src/gemini-cli/config/writer.js";
import { buildGeminiEnv } from "../../../src/gemini-cli/config/env.js";
import { parseEnvContent } from "../../../src/_core/config/loader.js";
import { checkEndpointHealth } from "../../../src/_core/api/health-check.js";
import type { GeminiCliConfig } from "../../../src/gemini-cli/config/loader.js";

const config: GeminiCliConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  organizationName: "Acme, Inc",
  productName: "Gemini Assistant Pro",
};

describe("generateEnvContent", () => {
  it("stores the API key as an OTLP header", () => {
    expect(generateEnvContent(config)).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS='x-api-key=hak_testkey123'",
    );
  });

  it("never exports a variable into the shell that sources it", () => {
    expect(generateEnvContent(config)).not.toContain("export ");
  });

  it("stops a legacy `source` before it reaches any assignment", () => {
    const lines = generateEnvContent(config).split("\n");
    const guardIndex = lines.indexOf("return 0 2>/dev/null");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(lines.slice(0, guardIndex).every((line) => line.startsWith("#"))).toBe(true);
  });

  it("writes no revenium.api_key resource attribute", () => {
    expect(generateEnvContent(config)).not.toContain("revenium.api_key");
  });

  it("round-trips every variable the launcher injects", () => {
    expect(parseEnvContent(generateEnvContent(config))).toEqual(buildGeminiEnv(config));
  });

  it("preserves quotes and separators in attribution values", () => {
    const parsed = parseEnvContent(
      generateEnvContent({
        apiKey: "hak_key",
        endpoint: "https://api.revenium.ai",
        organizationName: "O'Brien & Sons, Ltd",
        productName: "Product $NAME",
      }),
    );

    expect(parsed.REVENIUM_ORGANIZATION_NAME).toBe("O'Brien & Sons, Ltd");
    expect(parsed.REVENIUM_PRODUCT_NAME).toBe("Product $NAME");
  });
});

describe("writeConfig", () => {
  beforeEach(async () => {
    homeState.dir = await mkdtemp(join(tmpdir(), "gemini-writer-"));
  });

  afterEach(async () => {
    const home = homeState.dir;
    homeState.dir = "";
    await rm(home, { recursive: true, force: true });
  });

  it("writes the env file and no separate fish file", async () => {
    const envPath = await writeConfig(config);

    expect(envPath).toBe(join(homeState.dir, ".gemini", "revenium.env"));
    expect(await readdir(join(homeState.dir, ".gemini"))).toEqual(["revenium.env"]);
  });
});

describe("written configuration against setup validation", () => {
  beforeEach(async () => {
    homeState.dir = await mkdtemp(join(tmpdir(), "gemini-transport-"));
  });

  afterEach(async () => {
    const home = homeState.dir;
    homeState.dir = "";
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("delivers the key through the same header and URL the setup check validated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkEndpointHealth(config.endpoint, config.apiKey, "gemini-cli");
    const [validatedUrl, request] = fetchMock.mock.calls[0] as [string, RequestInit];

    const written = parseEnvContent(await readFile(await writeConfig(config), "utf-8"));
    const [headerName, headerValue] = written.OTEL_EXPORTER_OTLP_HEADERS.split("=");

    expect(headerName).toBe("x-api-key");
    expect(headerValue).toBe((request.headers as Record<string, string>)["x-api-key"]);
    expect(validatedUrl).toBe(`${written.GEMINI_TELEMETRY_OTLP_ENDPOINT}/v1/logs`);
  });
});

describe("generateEnvContent — prompt export", () => {
  it("never switches Gemini prompt logging on", () => {
    const content = generateEnvContent(config);

    expect(content).toContain("GEMINI_TELEMETRY_LOG_PROMPTS='false'");
    expect(content).not.toContain("GEMINI_TELEMETRY_LOG_PROMPTS='true'");
  });
});
