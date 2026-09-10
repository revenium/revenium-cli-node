import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = { current: "" };

vi.mock("../../../src/copilot/config/loader.js", () => ({
  getConfigDir: () => configDir.current,
}));

import { writeConfig } from "../../../src/copilot/config/writer.js";
import { createCopilotConfig } from "../../helpers/fixtures.js";

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

    expect(env).toContain("REVENIUM_API_KEY=hak_tenant_abc123xyz");
  });

  it("emits the GitHub credential lines for a legacy config that carries one", async () => {
    const { envPath } = await writeConfig(
      createCopilotConfig({ githubToken: "ghp_legacy", githubOrg: "acme" }),
    );

    const env = await readFile(envPath, "utf-8");

    expect(env).toContain("GITHUB_TOKEN=ghp_legacy");
    expect(env).toContain("GITHUB_ORG=acme");
  });
});
