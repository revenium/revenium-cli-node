import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = { current: "" };

vi.mock("../../../src/cursor/config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cursor/config/loader.js")>();
  return { ...actual, getConfigDir: () => configDir.current };
});

import { writeConfig } from "../../../src/cursor/config/writer.js";
import { loadConfig, getManagementEndpoint } from "../../../src/claude-code/config/loader.js";
import { REVENIUM_ENV_FILE } from "../../../src/_core/constants.js";
import { createCursorConfig } from "../../helpers/fixtures.js";

async function stubConfigFile(lines: string[]): Promise<void> {
  const envPath = join(configDir.current, REVENIUM_ENV_FILE);
  await writeFile(envPath, `${lines.join("\n")}\n`, "utf-8");
  vi.stubEnv("REVENIUM_CONFIG_PATH", envPath);
}

describe("loadConfig — Cursor-written configuration", () => {
  beforeEach(async () => {
    configDir.current = await mkdtemp(join(tmpdir(), "revenium-cursor-fallback-"));
    vi.unstubAllEnvs();
    vi.stubEnv("REVENIUM_MGMT_ENDPOINT", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(configDir.current, { recursive: true, force: true });
  });

  it("loads a configuration written by the Cursor writer", async () => {
    const { envPath } = await writeConfig(
      createCursorConfig({
        email: "dev@revenium.io",
        organizationName: "Revenium",
        productName: "Cursor IDE",
      }),
    );
    vi.stubEnv("REVENIUM_CONFIG_PATH", envPath);

    const config = await loadConfig();

    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("hak_tenant_abc123xyz");
    expect(config?.endpoint).toBe("https://api.revenium.ai");
    expect(config?.email).toBe("dev@revenium.io");
    expect(config?.organizationName).toBe("Revenium");
    expect(config?.productName).toBe("Cursor IDE");
  });

  it("defaults the endpoint to the Revenium base when the file carries no endpoint", async () => {
    await stubConfigFile([`export REVENIUM_API_KEY='hak_tenant_abc123xyz'`]);

    const config = await loadConfig();

    expect(config?.endpoint).toBe("https://api.revenium.ai");
    expect(getManagementEndpoint(config!.endpoint, config?.managementEndpoint)).toBe(
      "https://api.revenium.ai/profitstream",
    );
  });

  it("prefers the Claude Code header key when a single file carries both forms", async () => {
    await stubConfigFile([
      `export OTEL_EXPORTER_OTLP_HEADERS='x-api-key=hak_header_key'`,
      `export REVENIUM_API_KEY='hak_plain_key'`,
    ]);

    const config = await loadConfig();

    expect(config?.apiKey).toBe("hak_header_key");
  });

  it("returns null when REVENIUM_API_KEY holds only whitespace", async () => {
    await stubConfigFile([`export REVENIUM_API_KEY='   '`]);

    expect(await loadConfig()).toBeNull();
  });

  it("returns null when the Cursor file has only the Cursor-side key", async () => {
    await stubConfigFile([`export REVENIUM_CURSOR_API_KEY='cursor_key_12345'`]);

    expect(await loadConfig()).toBeNull();
  });
});
