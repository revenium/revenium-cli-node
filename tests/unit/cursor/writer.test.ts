import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = { current: "" };

vi.mock("../../../src/cursor/config/loader.js", () => ({
  getConfigDir: () => configDir.current,
}));

import { writeConfig } from "../../../src/cursor/config/writer.js";
import { parseEnvContent } from "../../../src/_core/config/loader.js";
import { createCursorConfig } from "../../helpers/fixtures.js";
import {
  HOSTILE_SHELL_VALUES,
  POSIX_SHELLS,
  FISH_AVAILABLE,
  readExportedVar,
  readExportedVarFromPosixShell,
} from "../../helpers/shell-env.js";
import { stripNewlines } from "../../../src/_core/shell/escaping.js";

const DEVELOPER_KEY_NAME = "CURSOR_API_KEY";
const DEVELOPER_KEY_VALUE = "key_DEVELOPER";
const LEGACY_ASSIGNMENT = /^(export |set -gx )CURSOR_API_KEY[= ]/m;

describe("cursor writeConfig", () => {
  beforeEach(async () => {
    configDir.current = await mkdtemp(join(tmpdir(), "revenium-cursor-writer-"));
  });

  afterEach(async () => {
    await rm(configDir.current, { recursive: true, force: true });
  });

  it("exports every value quoted", async () => {
    const { envPath } = await writeConfig(createCursorConfig());
    const env = await readFile(envPath, "utf-8");

    expect(env).toContain("export REVENIUM_CURSOR_API_KEY='cursor_key_12345'");
    expect(env).toContain("export REVENIUM_API_KEY='hak_tenant_abc123xyz'");
    expect(env).toContain("export REVENIUM_ENDPOINT='https://api.revenium.ai'");
  });

  it("assigns the Cursor admin key under the Revenium-prefixed name in both files", async () => {
    const { envPath, fishPath } = await writeConfig(createCursorConfig());

    expect(await readFile(fishPath, "utf-8")).toContain(
      "set -gx REVENIUM_CURSOR_API_KEY 'cursor_key_12345'",
    );
    for (const path of [envPath, fishPath]) {
      expect(await readFile(path, "utf-8")).not.toMatch(LEGACY_ASSIGNMENT);
    }
  });

  it.each(POSIX_SHELLS)(
    "leaves a developer's own CURSOR_API_KEY untouched in %s",
    async (shell) => {
      const { envPath } = await writeConfig(createCursorConfig());

      const { stdout } = await readExportedVar(
        shell,
        `export ${DEVELOPER_KEY_NAME}='${DEVELOPER_KEY_VALUE}'; . "${envPath}"`,
        DEVELOPER_KEY_NAME,
      );

      expect(stdout).toBe(DEVELOPER_KEY_VALUE);
    },
  );

  it("leaves a developer's own CURSOR_API_KEY untouched in fish", async ({ skip }) => {
    if (!FISH_AVAILABLE) {
      skip("fish is not installed on this machine");
    }

    const { fishPath } = await writeConfig(createCursorConfig());

    const { stdout } = await readExportedVar(
      "fish",
      `set -gx ${DEVELOPER_KEY_NAME} ${DEVELOPER_KEY_VALUE}; source "${fishPath}"`,
      DEVELOPER_KEY_NAME,
    );

    expect(stdout).toBe(DEVELOPER_KEY_VALUE);
  });

  it("omits the optional keys that are not configured", async () => {
    const { envPath, fishPath } = await writeConfig(createCursorConfig());
    const env = await readFile(envPath, "utf-8");
    const fish = await readFile(fishPath, "utf-8");

    for (const key of [
      "REVENIUM_SUBSCRIBER_EMAIL",
      "REVENIUM_ORGANIZATION_NAME",
      "REVENIUM_PRODUCT_NAME",
      "REVENIUM_SYNC_INTERVAL_MS",
      "CURSOR_SUBSCRIPTION_TIER",
    ]) {
      expect(env).not.toContain(key);
      expect(fish).not.toContain(key);
    }
    expect(env).not.toContain("=''");
  });

  it("quotes the sync interval in both files when it differs from the default", async () => {
    const { envPath, fishPath } = await writeConfig(createCursorConfig({ syncIntervalMs: 60000 }));

    expect(await readFile(envPath, "utf-8")).toContain("export REVENIUM_SYNC_INTERVAL_MS='60000'");
    expect(await readFile(fishPath, "utf-8")).toContain(
      "set -gx REVENIUM_SYNC_INTERVAL_MS '60000'",
    );
  });

  describe.each(POSIX_SHELLS)("sourced by %s", (shell) => {
    it.each(HOSTILE_SHELL_VALUES)(
      "exports %j to a child process without running it",
      async (organizationName) => {
        const { envPath } = await writeConfig(createCursorConfig({ organizationName }));

        const { stdout, stderr } = await readExportedVarFromPosixShell(
          shell,
          envPath,
          "REVENIUM_ORGANIZATION_NAME",
        );

        expect(stderr).toBe("");
        expect(stdout).toBe(stripNewlines(organizationName));
      },
    );
  });

  it.each(POSIX_SHELLS)("runs no command substitution in %s", async (shell) => {
    const sentinel = join(configDir.current, "substitution-ran");
    const { envPath } = await writeConfig(
      createCursorConfig({ productName: `Build$(touch ${sentinel})\`touch ${sentinel}\`` }),
    );

    await readExportedVarFromPosixShell(shell, envPath, "REVENIUM_PRODUCT_NAME");

    await expect(access(sentinel)).rejects.toThrow();
  });

  it("round-trips hostile values through the env and fish parsers", async () => {
    for (const value of HOSTILE_SHELL_VALUES) {
      const { envPath, fishPath } = await writeConfig(
        createCursorConfig({ organizationName: value, productName: value }),
      );

      const env = parseEnvContent(await readFile(envPath, "utf-8"));
      const fish = parseEnvContent(await readFile(fishPath, "utf-8"), true);

      expect(env.REVENIUM_ORGANIZATION_NAME).toBe(stripNewlines(value));
      expect(fish.REVENIUM_ORGANIZATION_NAME).toBe(stripNewlines(value));
    }
  });

  it("exports hostile values when the fish file is sourced", async ({ skip }) => {
    if (!FISH_AVAILABLE) {
      skip("fish is not installed on this machine");
    }

    for (const organizationName of HOSTILE_SHELL_VALUES) {
      const { fishPath } = await writeConfig(createCursorConfig({ organizationName }));

      const { stdout, stderr } = await readExportedVar(
        "fish",
        `source "${fishPath}"`,
        "REVENIUM_ORGANIZATION_NAME",
      );

      expect(stderr).toBe("");
      expect(stdout).toBe(stripNewlines(organizationName));
    }
  });
});
