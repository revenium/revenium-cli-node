import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const renameState = vi.hoisted(() => ({ failing: false }));
const managedState = vi.hoisted(() => ({ content: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: (...args: Parameters<typeof actual.rename>) =>
      renameState.failing ? Promise.reject(new Error("rename failed")) : actual.rename(...args),
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (!String(args[0]).endsWith("managed-settings.json")) return actual.readFile(...args);
      if (managedState.content !== null) return Promise.resolve(managedState.content);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
  };
});
import {
  applyTelemetryEnv,
  readTelemetryEnv,
  resolveLogToolDetails,
  getClaudeSettingsPath,
} from "../../../src/claude-code/config/claude-settings.js";
import type { ClaudeCodeConfig } from "../../../src/claude-code/config/loader.js";

const config: ClaudeCodeConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  teamId: "teamHash123",
};

let configDir = "";

function settingsPath(): string {
  return getClaudeSettingsPath();
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath(), "utf-8"));
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "claude-settings-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
});

afterEach(async () => {
  renameState.failing = false;
  managedState.content = null;
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

describe("applyTelemetryEnv", () => {
  it("creates settings.json with every telemetry variable scoped to Claude Code", async () => {
    const result = await applyTelemetryEnv(config);

    expect(result.applied).toBe(true);
    const env = (await readSettingsFile()).env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://api.revenium.ai/meter/v2/otlp");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-api-key=hak_testkey123");
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("user.email=user@example.com");
  });

  it("preserves unrelated settings and unrelated env entries", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({
        model: "opus",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
        env: { MY_OWN_VAR: "keep-me" },
      }),
    );

    await applyTelemetryEnv(config);

    const settings = await readSettingsFile();
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    });
    expect((settings.env as Record<string, string>).MY_OWN_VAR).toBe("keep-me");
  });

  it("drops a telemetry variable that is no longer configured", async () => {
    await applyTelemetryEnv({ ...config, teamId: "teamHash123" });
    expect((await readSettingsFile()).env).toHaveProperty("REVENIUM_TEAM_ID");

    await applyTelemetryEnv({ ...config, teamId: undefined });
    expect((await readSettingsFile()).env).not.toHaveProperty("REVENIUM_TEAM_ID");
  });

  it("backs up the previous settings before overwriting them", async () => {
    await writeFile(settingsPath(), JSON.stringify({ model: "opus" }));

    await applyTelemetryEnv(config);

    const backups = (await readdir(configDir)).filter((name) =>
      name.startsWith("settings.json.revenium-backup-"),
    );
    expect(backups).toHaveLength(1);
  });

  it("keeps the API key out of a world-readable file", async () => {
    await applyTelemetryEnv(config);

    const mode = (await stat(settingsPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates a missing configuration directory private to the owner", async () => {
    const createdDir = join(configDir, "created");
    vi.stubEnv("CLAUDE_CONFIG_DIR", createdDir);

    await applyTelemetryEnv(config);

    const mode = (await stat(createdDir)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("restricts the permissions of a backup taken from a world-readable file", async () => {
    await writeFile(settingsPath(), JSON.stringify({ model: "opus" }));
    await chmod(settingsPath(), 0o644);

    await applyTelemetryEnv(config);

    const backup = (await readdir(configDir)).find((name) =>
      name.startsWith("settings.json.revenium-backup-"),
    );
    const mode = (await stat(join(configDir, backup as string))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reports an unparseable settings file and leaves it untouched", async () => {
    await writeFile(settingsPath(), "{ not json");

    const result = await applyTelemetryEnv(config);

    expect(result.applied).toBe(false);
    expect(result.error).toContain("Invalid JSON");
    expect(await readFile(settingsPath(), "utf-8")).toBe("{ not json");
  });

  it("leaves the original file intact when the write fails", async () => {
    const original = JSON.stringify({ model: "opus" });
    await writeFile(settingsPath(), original);
    renameState.failing = true;

    const result = await applyTelemetryEnv(config);

    expect(result.applied).toBe(false);
    expect(await readFile(settingsPath(), "utf-8")).toBe(original);
    expect((await readdir(configDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("keeps only the most recent backups", async () => {
    await writeFile(settingsPath(), JSON.stringify({ model: "opus" }));
    for (let i = 1; i <= 7; i++) {
      await writeFile(
        join(configDir, `settings.json.revenium-backup-2026-01-0${i}T00-00-00-000Z`),
        "{}",
      );
    }

    await applyTelemetryEnv(config);

    const backups = (await readdir(configDir)).filter((name) =>
      name.startsWith("settings.json.revenium-backup-"),
    );
    expect(backups).toHaveLength(5);
  });
});

describe("readTelemetryEnv", () => {
  it("returns only the telemetry variables this CLI owns", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ env: { MY_OWN_VAR: "keep-me", OTEL_LOG_TOOL_DETAILS: "0" } }),
    );

    const report = await readTelemetryEnv(settingsPath());

    expect(report.env).toEqual({ OTEL_LOG_TOOL_DETAILS: "0" });
  });

  it("reads a missing file as no telemetry rather than an error", async () => {
    const report = await readTelemetryEnv(settingsPath());

    expect(report.env).toEqual({});
    expect(report.error).toBeUndefined();
  });

  it("reports an unparseable settings file", async () => {
    await writeFile(settingsPath(), "{ not json");

    const report = await readTelemetryEnv(settingsPath());

    expect(report.error).toContain("Invalid JSON");
  });
});

describe("resolveLogToolDetails", () => {
  it("honours an opt-out written straight into Claude Code's settings", async () => {
    await writeFile(settingsPath(), JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: "0" } }));

    expect(await resolveLogToolDetails({ ...config, logToolDetails: true })).toEqual({
      value: false,
    });
  });

  it("honours an opt-in written straight into Claude Code's settings", async () => {
    await writeFile(settingsPath(), JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: "1" } }));

    expect(await resolveLogToolDetails({ ...config, logToolDetails: false })).toEqual({
      value: true,
    });
  });

  it("honours the organization's managed opt-out over the developer's own opt-in", async () => {
    await writeFile(settingsPath(), JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: "1" } }));
    managedState.content = JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: "0" } });

    expect(await resolveLogToolDetails({ ...config, logToolDetails: true })).toEqual({
      value: false,
    });
  });

  it("falls back to the Revenium configuration when Claude Code's settings say nothing", async () => {
    expect(await resolveLogToolDetails({ ...config, logToolDetails: false })).toEqual({
      value: false,
    });
    expect(await resolveLogToolDetails({ ...config, logToolDetails: undefined })).toEqual({
      value: undefined,
    });
  });

  it("withholds skill names when the developer's settings cannot be parsed", async () => {
    await writeFile(settingsPath(), "{ not json");

    expect(await resolveLogToolDetails({ ...config, logToolDetails: true })).toEqual({
      value: false,
      unreadablePath: settingsPath(),
    });
  });

  it("withholds skill names when the managed settings cannot be parsed", async () => {
    await writeFile(settingsPath(), JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: "1" } }));
    managedState.content = "{ not json";

    const resolved = await resolveLogToolDetails({ ...config, logToolDetails: true });

    expect(resolved.value).toBe(false);
    expect(resolved.unreadablePath).toContain("managed-settings.json");
  });
});
