import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = { current: "" };

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.current,
}));

import { loadMigratedConfig } from "../../../src/cursor/commands/migrated-config.js";
import {
  getConfigDir,
  getConfigPath,
  getFishConfigPath,
} from "../../../src/cursor/config/loader.js";

const REVENIUM_CREDENTIAL = "export REVENIUM_API_KEY='hak_tenant_abc123xyz'";
const LEGACY_ASSIGNMENT = /^(export |set -gx )CURSOR_API_KEY[= ]/m;

async function writeConfigFiles(envContent: string, fishContent: string): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(getConfigPath(), envContent, "utf-8");
  await writeFile(getFishConfigPath(), fishContent, "utf-8");
}

describe("cursor loadMigratedConfig", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  function loggedOutput(): string {
    return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
  }

  beforeEach(async () => {
    home.current = await mkdtemp(join(tmpdir(), "revenium-cursor-migration-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await chmod(getConfigDir(), 0o700).catch(() => {});
    await rm(home.current, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("renames the key in both shell files when it still uses the name Cursor reads", async () => {
    await writeConfigFiles(
      ["export CURSOR_API_KEY='key_legacy123'", REVENIUM_CREDENTIAL].join("\n"),
      "set -gx CURSOR_API_KEY 'key_legacy123'",
    );

    const config = await loadMigratedConfig();

    expect(config?.cursorApiKey).toBe("key_legacy123");
    for (const path of [getConfigPath(), getFishConfigPath()]) {
      const content = await readFile(path, "utf-8");
      expect(content).toContain("key_legacy123");
      expect(content).toContain("REVENIUM_CURSOR_API_KEY");
      expect(content).not.toMatch(LEGACY_ASSIGNMENT);
    }
  });

  it("drops the leftover legacy assignment when both names are present", async () => {
    await writeConfigFiles(
      [
        "export REVENIUM_CURSOR_API_KEY='key_cursoradmin123'",
        "export CURSOR_API_KEY='key_legacy123'",
        REVENIUM_CREDENTIAL,
      ].join("\n"),
      [
        "set -gx REVENIUM_CURSOR_API_KEY 'key_cursoradmin123'",
        "set -gx CURSOR_API_KEY 'key_legacy123'",
      ].join("\n"),
    );

    const config = await loadMigratedConfig();

    expect(config?.cursorApiKey).toBe("key_cursoradmin123");
    for (const path of [getConfigPath(), getFishConfigPath()]) {
      const content = await readFile(path, "utf-8");
      expect(content).toContain("key_cursoradmin123");
      expect(content).not.toContain("key_legacy123");
      expect(content).not.toMatch(LEGACY_ASSIGNMENT);
    }
  });

  it("keeps comments and keys the Cursor config model does not hold", async () => {
    const envContent = [
      "# Revenium Cursor metering",
      "export CURSOR_API_KEY='key_legacy123'",
      REVENIUM_CREDENTIAL,
      "export CURSOR_PAGE_SIZE=500",
      "export REVENIUM_TEAM_ID='team_abc'",
    ].join("\n");
    await writeConfigFiles(envContent, "set -gx CURSOR_API_KEY 'key_legacy123'");

    await loadMigratedConfig();

    const content = await readFile(getConfigPath(), "utf-8");
    expect(content).toBe(envContent.replace("CURSOR_API_KEY=", "REVENIUM_CURSOR_API_KEY="));
  });

  it("leaves an already migrated configuration untouched", async () => {
    const envContent = [
      "export REVENIUM_CURSOR_API_KEY='key_cursoradmin123'",
      REVENIUM_CREDENTIAL,
    ].join("\n");
    await writeConfigFiles(envContent, "set -gx REVENIUM_CURSOR_API_KEY 'key_cursoradmin123'");

    const config = await loadMigratedConfig();

    expect(config?.cursorApiKey).toBe("key_cursoradmin123");
    await expect(readFile(getConfigPath(), "utf-8")).resolves.toBe(envContent);
    expect(loggedOutput()).toBe("");
  });

  it("tells the developer the key was renamed and that a new terminal is needed", async () => {
    await writeConfigFiles(
      ["export CURSOR_API_KEY='key_legacy123'", REVENIUM_CREDENTIAL].join("\n"),
      "set -gx CURSOR_API_KEY 'key_legacy123'",
    );

    await loadMigratedConfig();

    const output = loggedOutput();
    expect(output).toContain(getConfigPath());
    expect(output).toContain("REVENIUM_CURSOR_API_KEY");
    expect(output).toContain("new terminal");
    expect(output).not.toContain("key_legacy123");
  });

  it("names the unwritable file and retries it on the next run", async () => {
    await writeConfigFiles(
      ["export CURSOR_API_KEY='key_legacy123'", REVENIUM_CREDENTIAL].join("\n"),
      "set -gx CURSOR_API_KEY 'key_legacy123'",
    );
    await chmod(getFishConfigPath(), 0o400);

    const config = await loadMigratedConfig();

    expect(config?.cursorApiKey).toBe("key_legacy123");
    expect(loggedOutput()).toContain(getFishConfigPath());
    await expect(readFile(getFishConfigPath(), "utf-8")).resolves.toMatch(LEGACY_ASSIGNMENT);

    await chmod(getFishConfigPath(), 0o600);
    await loadMigratedConfig();

    await expect(readFile(getFishConfigPath(), "utf-8")).resolves.not.toMatch(LEGACY_ASSIGNMENT);
  });
});
