import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const dist = resolve("dist");

const binEntries = [
  { name: "revenium-metering", path: "claude-code/cli/index.js" },
  { name: "revenium-gemini", path: "gemini-cli/cli/index.js" },
  { name: "revenium-cursor", path: "cursor/cli/index.js" },
];

describe("CLI binaries", () => {
  it.each(binEntries)("$name --help exits 0 and shows usage", ({ path }) => {
    const fullPath = join(dist, path);
    if (!existsSync(fullPath)) {
      return;
    }

    const output = execFileSync(process.execPath, [fullPath, "--help"], {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "" },
    });

    expect(output).toMatch(/usage|Usage|help|setup|status|Options/i);
  });
});
