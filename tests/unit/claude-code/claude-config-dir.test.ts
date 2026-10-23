import { describe, it, expect, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getClaudeConfigDir,
  getClaudeProjectsDir,
} from "../../../src/claude-code/config/claude-config-dir.js";
import { getClaudeSettingsPath } from "../../../src/claude-code/config/claude-settings.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getClaudeConfigDir", () => {
  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);

    expect(getClaudeConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("follows CLAUDE_CONFIG_DIR when it is set", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/opt/claude-home");

    expect(getClaudeConfigDir()).toBe("/opt/claude-home");
  });

  it("treats a whitespace-only CLAUDE_CONFIG_DIR as unset", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "   ");

    expect(getClaudeConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("is read per call, so a variable set after import still applies", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/opt/first");
    expect(getClaudeConfigDir()).toBe("/opt/first");

    vi.stubEnv("CLAUDE_CONFIG_DIR", "/opt/second");
    expect(getClaudeConfigDir()).toBe("/opt/second");
  });
});

describe("the transcripts folder and the settings file share one parent", () => {
  it.each(["/opt/claude-home", undefined])("agree for CLAUDE_CONFIG_DIR=%s", (value) => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", value);

    expect(dirname(getClaudeProjectsDir())).toBe(dirname(getClaudeSettingsPath()));
  });

  it("puts the transcripts under the override", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/opt/claude-home");

    expect(getClaudeProjectsDir()).toBe(join("/opt/claude-home", "projects"));
  });
});
