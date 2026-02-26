import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectShell,
  getProfilePath,
  validateConfigPath,
} from "../../../src/_core/shell/detector.js";
import { homedir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("detectShell", () => {
  it("detects zsh from SHELL env", () => {
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
  });

  it("detects bash from SHELL env", () => {
    process.env.SHELL = "/bin/bash";
    expect(detectShell()).toBe("bash");
  });

  it("detects fish from SHELL env", () => {
    process.env.SHELL = "/usr/bin/fish";
    expect(detectShell()).toBe("fish");
  });
});

describe("getProfilePath", () => {
  const home = homedir();

  it("returns .zshrc for zsh", () => {
    expect(getProfilePath("zsh")).toBe(join(home, ".zshrc"));
  });

  it("returns fish config path for fish", () => {
    expect(getProfilePath("fish")).toBe(join(home, ".config", "fish", "config.fish"));
  });

  it("returns null for unknown shell", () => {
    expect(getProfilePath("unknown")).toBeNull();
  });
});

describe("validateConfigPath", () => {
  it("accepts safe path", () => {
    expect(() => validateConfigPath("/home/user/.claude/revenium.env")).not.toThrow();
  });

  it("rejects path with semicolons", () => {
    expect(() => validateConfigPath("/path;rm -rf /")).toThrow("unsafe characters");
  });

  it("rejects path with pipes", () => {
    expect(() => validateConfigPath("/path|evil")).toThrow("unsafe characters");
  });

  it("rejects path with backticks", () => {
    expect(() => validateConfigPath("/path/`cmd`")).toThrow("unsafe characters");
  });

  it("rejects path with dollar signs", () => {
    expect(() => validateConfigPath("/path/$HOME")).toThrow("unsafe characters");
  });
});
