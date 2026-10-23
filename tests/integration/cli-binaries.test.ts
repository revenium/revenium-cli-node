import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve("dist");

const binEntries = [
  { name: "revenium-metering", path: "claude-code/cli/index.js" },
  { name: "revenium-gemini", path: "gemini-cli/cli/index.js" },
  { name: "revenium-cursor", path: "cursor/cli/index.js" },
  { name: "revenium-copilot", path: "copilot/cli/index.js" },
  { name: "revenium-codex", path: "codex-cli/cli/index.js" },
];

describe.skipIf(!existsSync(dist))("CLI binaries", () => {
  it.each(binEntries)("$name --help exits 0 and shows usage", ({ path }) => {
    const fullPath = join(dist, path);

    const output = execFileSync(process.execPath, [fullPath, "--help"], {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "" },
    });

    expect(output).toMatch(/usage|Usage|help|setup|status|Options/i);
  });

  it.each(binEntries)("$name setup without a terminal fails on the missing key", ({ path }) => {
    const fullPath = join(dist, path);
    const home = mkdtempSync(join(tmpdir(), "revenium-scripted-"));

    try {
      const result = spawnSync(process.execPath, [fullPath, "setup"], {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, NODE_ENV: "production", NODE_OPTIONS: "" },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--api-key");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
