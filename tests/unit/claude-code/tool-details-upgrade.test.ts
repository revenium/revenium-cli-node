import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  existsSync: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  chmod: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/home/testuser" };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    chmod: mocks.chmod,
    rename: mocks.rename,
    unlink: mocks.unlink,
  };
});

import { ensureToolDetailsExport } from "../../../src/claude-code/config/writer.js";

const ENV_PATH = "/home/testuser/.claude/revenium.env";
const FISH_PATH = "/home/testuser/.claude/revenium.fish";

const LEGACY_ENV = [
  "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
  'export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=hak_testkey123"',
  "export OTEL_LOGS_EXPORTER=otlp",
  "",
].join("\n");

function statusFor(results: { path: string; status: string }[], path: string): string {
  return results.find((result) => result.path === path)?.status ?? "unknown";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.existsSync.mockImplementation((path: string) => mocks.files.has(path));
  mocks.readFile.mockImplementation(async (path: string) => mocks.files.get(path) ?? "");
  mocks.writeFile.mockImplementation(async (path: string, content: string) => {
    mocks.files.set(path, content);
  });
  mocks.chmod.mockResolvedValue(undefined);
  mocks.rename.mockImplementation(async (from: string, to: string) => {
    mocks.files.set(to, mocks.files.get(from) ?? "");
    mocks.files.delete(from);
  });
  mocks.unlink.mockResolvedValue(undefined);
});

describe("ensureToolDetailsExport", () => {
  it("adds the export to a config written before the flag existed", async () => {
    mocks.files.set(ENV_PATH, LEGACY_ENV);

    const results = await ensureToolDetailsExport();

    expect(statusFor(results, ENV_PATH)).toBe("added");
    expect(mocks.files.get(ENV_PATH)).toContain("export OTEL_LOG_TOOL_DETAILS=1");
    // The write lands on a temp file first (see the atomic-write test below), so chmod/writeFile
    // target the temp path; only the final `rename` produces the real ENV_PATH.
    expect(mocks.chmod).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${ENV_PATH}\\.\\d+\\.tmp$`)),
      0o600,
    );
  });

  it("preserves the existing content when appending", async () => {
    mocks.files.set(ENV_PATH, LEGACY_ENV);

    await ensureToolDetailsExport();

    expect(mocks.files.get(ENV_PATH)).toContain("export OTEL_LOGS_EXPORTER=otlp");
    expect(mocks.files.get(ENV_PATH)).toContain(
      'export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=hak_testkey123"',
    );
  });

  it("is idempotent, so a second run changes nothing", async () => {
    mocks.files.set(ENV_PATH, LEGACY_ENV);

    await ensureToolDetailsExport();
    const afterFirstRun = mocks.files.get(ENV_PATH);
    mocks.writeFile.mockClear();

    const results = await ensureToolDetailsExport();

    expect(statusFor(results, ENV_PATH)).toBe("already-set");
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.files.get(ENV_PATH)).toBe(afterFirstRun);
  });

  it("leaves a deliberate opt-out (=0) alone", async () => {
    mocks.files.set(ENV_PATH, `${LEGACY_ENV}export OTEL_LOG_TOOL_DETAILS=0\n`);

    const results = await ensureToolDetailsExport();

    expect(statusFor(results, ENV_PATH)).toBe("already-set");
    expect(mocks.files.get(ENV_PATH)).not.toContain("OTEL_LOG_TOOL_DETAILS=1");
  });

  it("appends a newline first when the file does not end with one", async () => {
    mocks.files.set(ENV_PATH, "export OTEL_LOGS_EXPORTER=otlp");

    await ensureToolDetailsExport();

    expect(mocks.files.get(ENV_PATH)).toContain("export OTEL_LOGS_EXPORTER=otlp\n");
  });

  it("upgrades the fish config with fish syntax", async () => {
    mocks.files.set(FISH_PATH, "set -gx OTEL_LOGS_EXPORTER otlp\n");

    const results = await ensureToolDetailsExport();

    expect(statusFor(results, FISH_PATH)).toBe("added");
    expect(mocks.files.get(FISH_PATH)).toContain("set -gx OTEL_LOG_TOOL_DETAILS 1");
  });

  it("reports no-file for a config that does not exist", async () => {
    const results = await ensureToolDetailsExport();

    expect(statusFor(results, ENV_PATH)).toBe("no-file");
    expect(statusFor(results, FISH_PATH)).toBe("no-file");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("writes via a temp file and renames it over the original, never truncating in place", async () => {
    mocks.files.set(ENV_PATH, LEGACY_ENV);

    await ensureToolDetailsExport();

    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${ENV_PATH}\\.\\d+\\.tmp$`)),
      expect.stringContaining("export OTEL_LOG_TOOL_DETAILS=1"),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${ENV_PATH}\\.\\d+\\.tmp$`)),
      ENV_PATH,
    );
    // The original path never receives a direct write. Only the temp file does.
    expect(mocks.writeFile).not.toHaveBeenCalledWith(
      ENV_PATH,
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.files.get(ENV_PATH)).toContain("export OTEL_LOG_TOOL_DETAILS=1");
  });
});

describe("ensureToolDetailsExport: REVENIUM_CONFIG_PATH override without a .env suffix", () => {
  const OVERRIDE_PATH = "/tmp/revenium-local-e2e";

  beforeEach(() => {
    process.env.REVENIUM_CONFIG_PATH = OVERRIDE_PATH;
  });

  afterEach(() => {
    delete process.env.REVENIUM_CONFIG_PATH;
  });

  it("upgrades the override path exactly once, never as a second fish pass over the same file", async () => {
    mocks.files.set(OVERRIDE_PATH, LEGACY_ENV);

    const results = await ensureToolDetailsExport();

    expect(results).toHaveLength(1);
    expect(statusFor(results, OVERRIDE_PATH)).toBe("added");
    // Exactly one bash-style export line was appended. A second fish-mode pass over the same
    // file would have appended a mismatched `set -gx` line as well.
    const content = mocks.files.get(OVERRIDE_PATH) ?? "";
    expect(content.match(/OTEL_LOG_TOOL_DETAILS/g)).toHaveLength(1);
    expect(content).toContain("export OTEL_LOG_TOOL_DETAILS=1");
    expect(content).not.toContain("set -gx OTEL_LOG_TOOL_DETAILS");
  });
});
