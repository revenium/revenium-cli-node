import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = { current: "" };

vi.mock("../../../src/copilot/config/loader.js", () => ({
  getConfigDir: () => configDir.current,
}));

import { writeConfig } from "../../../src/copilot/config/writer.js";
import { parseEnvContent } from "../../../src/_core/config/loader.js";
import { createCopilotConfig } from "../../helpers/fixtures.js";
import {
  HOSTILE_SHELL_VALUES,
  POSIX_SHELLS,
  FISH_AVAILABLE,
  readExportedVar,
  readExportedVarFromPosixShell,
} from "../../helpers/shell-env.js";
import { stripNewlines } from "../../../src/_core/shell/escaping.js";

describe("copilot writeConfig", () => {
  beforeEach(async () => {
    configDir.current = await mkdtemp(join(tmpdir(), "revenium-copilot-writer-"));
  });

  afterEach(async () => {
    await rm(configDir.current, { recursive: true, force: true });
  });

  async function writtenFiles() {
    const { envPath, fishPath } = await writeConfig(createCopilotConfig());
    return {
      env: await readFile(envPath, "utf-8"),
      fish: await readFile(fishPath, "utf-8"),
    };
  }

  it("omits the GitHub credential lines when no token is configured", async () => {
    const { env, fish } = await writtenFiles();

    expect(env).not.toContain("GITHUB_TOKEN");
    expect(env).not.toContain("GITHUB_ORG");
    expect(fish).not.toContain("GITHUB_TOKEN");
    expect(fish).not.toContain("GITHUB_ORG");
  });

  it("still writes the Revenium credential", async () => {
    const { env } = await writtenFiles();

    expect(env).toContain("export REVENIUM_API_KEY='hak_tenant_abc123xyz'");
  });

  it("emits the GitHub credential lines for a legacy config that carries one", async () => {
    const { envPath } = await writeConfig(
      createCopilotConfig({ githubToken: "ghp_legacy", githubOrg: "acme" }),
    );

    const env = await readFile(envPath, "utf-8");

    expect(env).toContain("export GITHUB_TOKEN='ghp_legacy'");
    expect(env).toContain("export GITHUB_ORG='acme'");
  });

  it("quotes the sync interval in both files when it differs from the default", async () => {
    const { envPath, fishPath } = await writeConfig(createCopilotConfig({ syncIntervalMs: 60000 }));

    expect(await readFile(envPath, "utf-8")).toContain("export REVENIUM_SYNC_INTERVAL_MS='60000'");
    expect(await readFile(fishPath, "utf-8")).toContain(
      "set -gx REVENIUM_SYNC_INTERVAL_MS '60000'",
    );
  });

  it("writes no empty assignment for an optional value that is not configured", async () => {
    const { env } = await writtenFiles();

    expect(env).not.toContain("=''");
  });

  describe.each(POSIX_SHELLS)("sourced by %s", (shell) => {
    it.each(HOSTILE_SHELL_VALUES)(
      "exports %j to a child process without running it",
      async (organizationName) => {
        const { envPath } = await writeConfig(createCopilotConfig({ organizationName }));

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
      createCopilotConfig({ productName: `Build$(touch ${sentinel})\`touch ${sentinel}\`` }),
    );

    await readExportedVarFromPosixShell(shell, envPath, "REVENIUM_PRODUCT_NAME");

    await expect(access(sentinel)).rejects.toThrow();
  });

  it("round-trips hostile values through the env and fish parsers", async () => {
    for (const value of HOSTILE_SHELL_VALUES) {
      const { envPath, fishPath } = await writeConfig(
        createCopilotConfig({ organizationName: value, productName: value }),
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
      const { fishPath } = await writeConfig(createCopilotConfig({ organizationName }));

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
