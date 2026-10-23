import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = { dir: "" };

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir || actual.homedir() };
});

import { loadConfig } from "../../../src/gemini-cli/config/loader.js";

const headerConfig = [
  "GEMINI_TELEMETRY_ENABLED='true'",
  "GEMINI_TELEMETRY_OTLP_ENDPOINT='https://api.revenium.ai/meter/v2/otlp'",
  "OTEL_EXPORTER_OTLP_HEADERS='x-api-key=hak_headerkey'",
  "REVENIUM_SUBSCRIBER_EMAIL='user@example.com'",
  "",
].join("\n");

const legacyConfig = [
  "export GEMINI_TELEMETRY_ENABLED='true'",
  "export GEMINI_TELEMETRY_OTLP_ENDPOINT='https://api.revenium.ai/meter/v2/otlp'",
  "export OTEL_RESOURCE_ATTRIBUTES='revenium.api_key=hak_legacykey,user.email=user@example.com'",
  "",
].join("\n");

let home: string;

async function writeGeminiEnv(content: string): Promise<void> {
  await mkdir(join(home, ".gemini"), { recursive: true });
  await writeFile(join(home, ".gemini", "revenium.env"), content, "utf-8");
}

describe("loadConfig", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "gemini-loader-"));
    homeState.dir = home;
    vi.stubEnv("SHELL", "/bin/bash");
  });

  afterEach(async () => {
    homeState.dir = "";
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("reads the API key from the OTLP header", async () => {
    await writeGeminiEnv(headerConfig);

    const config = await loadConfig();

    expect(config?.apiKey).toBe("hak_headerkey");
    expect(config?.legacy).toBe(false);
  });

  it("keeps the endpoint and attribution from a header configuration", async () => {
    await writeGeminiEnv(headerConfig);

    const config = await loadConfig();

    expect(config?.endpoint).toBe("https://api.revenium.ai");
    expect(config?.email).toBe("user@example.com");
  });

  it("still reads the API key from a pre-change resource attribute", async () => {
    await writeGeminiEnv(legacyConfig);

    const config = await loadConfig();

    expect(config?.apiKey).toBe("hak_legacykey");
  });

  it("flags a pre-change configuration as legacy", async () => {
    await writeGeminiEnv(legacyConfig);

    expect((await loadConfig())?.legacy).toBe(true);
  });

  it("returns null when no API key is present", async () => {
    await writeGeminiEnv("GEMINI_TELEMETRY_ENABLED='true'\n");

    expect(await loadConfig()).toBeNull();
  });

  it("reads an API key whose prefix the CLI does not know yet", async () => {
    await writeGeminiEnv("OTEL_EXPORTER_OTLP_HEADERS='x-api-key=new_futurekey'\n");

    expect((await loadConfig())?.apiKey).toBe("new_futurekey");
  });
});
