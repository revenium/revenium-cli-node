import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home.path };
});

vi.mock("inquirer", () => ({ default: { prompt: vi.fn(async () => ({})) } }));

vi.mock("../../src/cursor/core/cursor-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/cursor/core/cursor-client.js")>(
    "../../src/cursor/core/cursor-client.js",
  );
  return { ...actual, testConnectivity: vi.fn(async () => true) };
});

import { OTLP_PATH } from "../../src/_core/constants.js";
import { createOtlpCaptureServer, type OtlpCaptureServer } from "../helpers/otlp-capture-server.js";
import { setupCommand as claudeSetupCommand } from "../../src/claude-code/commands/setup.js";
import { setupCommand as geminiSetupCommand } from "../../src/gemini-cli/commands/setup.js";
import { setupCommand as copilotSetupCommand } from "../../src/copilot/commands/setup.js";
import { setupCommand as cursorSetupCommand } from "../../src/cursor/commands/setup.js";
import { setupAction as codexSetupCommand } from "../../src/codex-cli/commands/setup.js";
import { loadConfig as loadClaudeConfig } from "../../src/claude-code/config/loader.js";
import { loadConfig as loadGeminiConfig } from "../../src/gemini-cli/config/loader.js";
import { loadConfig as loadCopilotConfig } from "../../src/copilot/config/loader.js";
import { loadConfig as loadCursorConfig } from "../../src/cursor/config/loader.js";
import { readCodexToml } from "../../src/codex-cli/config/loader.js";
import { testCommand as claudeTestCommand } from "../../src/claude-code/commands/test.js";
import { statusCommand as claudeStatusCommand } from "../../src/claude-code/commands/status.js";
import { backfillCommand as claudeBackfillCommand } from "../../src/claude-code/commands/backfill.js";
import { testCommand as geminiTestCommand } from "../../src/gemini-cli/commands/test.js";
import { statusCommand as geminiStatusCommand } from "../../src/gemini-cli/commands/status.js";
import { testCommand as copilotTestCommand } from "../../src/copilot/commands/test.js";
import { testCommand as cursorTestCommand } from "../../src/cursor/commands/test.js";
import { testAction as codexTestCommand } from "../../src/codex-cli/commands/test.js";
import { statusAction as codexStatusCommand } from "../../src/codex-cli/commands/status.js";
import { backfillAction as codexBackfillCommand } from "../../src/codex-cli/commands/backfill.js";

const GATEWAY_PREFIX = "/revenium";
const API_KEY = "hak_tenant_prefixedkey123";
const CURSOR_API_KEY = "key_cursoradmin123";

function writeClaudeSessionRecord(): void {
  const projectDir = join(home.path, ".claude", "projects", "demo");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "session.jsonl"),
    JSON.stringify({
      type: "assistant",
      requestId: "req_prefixed",
      sessionId: "session-prefixed",
      timestamp: "2024-06-01T12:00:00.000Z",
      message: {
        id: "msg_prefixed",
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + "\n",
  );
}

function codexSessionsPath(): string {
  return join(home.path, ".codex", "sessions");
}

function writeCodexRolloutFile(): void {
  const sessionsDir = codexSessionsPath();
  mkdirSync(sessionsDir, { recursive: true });
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 10,
    reasoning_output_tokens: 5,
    total_tokens: 165,
  };
  const lines = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-session-prefixed", originator: "codex-exec" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2024-06-01T12:00:00.000Z",
      payload: {
        type: "token_count",
        info: {
          model: "gpt-5-codex",
          last_token_usage: usage,
          total_token_usage: usage,
        },
      },
    }),
  ];
  writeFileSync(join(sessionsDir, "rollout-prefixed.jsonl"), lines.join("\n") + "\n");
}

function codexConfigPath(): string {
  return join(home.path, ".codex", "config.toml");
}

describe("path-prefixed gateway endpoint", () => {
  let server: OtlpCaptureServer;

  beforeAll(async () => {
    process.env.REVENIUM_STARTUP_STAGGER_MS = "0";
    home.path = mkdtempSync(join(tmpdir(), "revenium-prefixed-"));

    server = createOtlpCaptureServer({ basePath: GATEWAY_PREFIX });
    await server.start();
    const setupEndpoint = `${server.baseUrl}${OTLP_PATH}/v1/logs`;

    process.env.REVENIUM_CONFIG_PATH = join(home.path, ".claude", "revenium.env");

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);

    await claudeSetupCommand({ apiKey: API_KEY, endpoint: setupEndpoint });
    await geminiSetupCommand({ apiKey: API_KEY, endpoint: setupEndpoint });
    await codexSetupCommand({
      apiKey: API_KEY,
      endpoint: setupEndpoint,
      configPath: codexConfigPath(),
      force: true,
    });
    await copilotSetupCommand({
      reveniumApiKey: API_KEY,
      endpoint: setupEndpoint,
      subscriptionTier: "business",
    });
    await cursorSetupCommand({
      cursorApiKey: CURSOR_API_KEY,
      reveniumApiKey: API_KEY,
      endpoint: setupEndpoint,
      subscriptionTier: "business",
    });

    writeClaudeSessionRecord();
    writeCodexRolloutFile();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.REVENIUM_CONFIG_PATH;
    delete process.env.REVENIUM_STARTUP_STAGGER_MS;
    await server.stop();
    rmSync(home.path, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.reset();
  });

  function expectPrefixedOtlpRequests(signal = "logs"): void {
    expect(server.requests.map((request) => request.url)).toContain(
      `${GATEWAY_PREFIX}${OTLP_PATH}/v1/${signal}`,
    );
    for (const request of server.requests) {
      expect(request.url.startsWith(`${GATEWAY_PREFIX}/`)).toBe(true);
    }
  }

  it("keeps the gateway prefix in every configuration setup writes", async () => {
    expect((await loadClaudeConfig())?.endpoint).toBe(server.baseUrl);
    expect((await loadGeminiConfig())?.endpoint).toBe(server.baseUrl);
    expect((await loadCopilotConfig())?.reveniumEndpoint).toBe(server.baseUrl);
    expect((await loadCursorConfig())?.reveniumEndpoint).toBe(server.baseUrl);
    expect(await readCodexToml(codexConfigPath())).toContain(
      `${server.baseUrl}${OTLP_PATH}/v1/logs`,
    );
  });

  it("sends Claude Code test metrics to the prefixed path", async () => {
    await claudeTestCommand();
    expectPrefixedOtlpRequests();
  });

  it("sends Claude Code status health checks to the prefixed path", async () => {
    await claudeStatusCommand();
    expectPrefixedOtlpRequests();
  });

  it("sends Claude Code backfill batches to the prefixed path", async () => {
    await claudeBackfillCommand();
    expectPrefixedOtlpRequests();
  });

  it("sends Gemini test metrics to the prefixed path", async () => {
    await geminiTestCommand();
    expectPrefixedOtlpRequests();
  });

  it("sends Gemini status health checks to the prefixed path", async () => {
    await geminiStatusCommand();
    expectPrefixedOtlpRequests();
  });

  it("sends Codex test metrics to the prefixed path", async () => {
    await codexTestCommand({ configPath: codexConfigPath() });
    expectPrefixedOtlpRequests();
  });

  it("sends Codex status health checks to the prefixed path", async () => {
    await codexStatusCommand({ configPath: codexConfigPath() });
    expectPrefixedOtlpRequests();
  });

  it("sends Codex backfill batches to the prefixed path", async () => {
    await codexBackfillCommand({
      configPath: codexConfigPath(),
      sessionsPath: codexSessionsPath(),
      since: "2024-01-01",
      to: "2024-12-31",
    });
    expectPrefixedOtlpRequests();
  });

  it("sends Copilot test metrics to the prefixed path", async () => {
    await copilotTestCommand();
    expectPrefixedOtlpRequests("traces");
  });

  it("sends Cursor test metrics to the prefixed path", async () => {
    await cursorTestCommand();
    expectPrefixedOtlpRequests();
  });
});
