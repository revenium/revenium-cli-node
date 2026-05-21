import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/codex-cli/config/loader.js", () => ({
  readCodexToml: vi.fn().mockResolvedValue('[otel]\nendpoint = "https://api.revenium.ai"\n'),
  extractOtelValues: vi.fn().mockReturnValue({
    endpoint: "https://api.revenium.ai",
    apiKey: "hak_test_key",
  }),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn().mockResolvedValue(undefined),
}));

import {
  parseCompletedEvent,
  parseSessionMeta,
  parseTurnContextModel,
  parseTokenCountEvent,
  hashTransactionId,
  parseDateInput,
  backfillAction,
  type ParsedCodexEvent,
  type RolloutContext,
} from "../../../src/codex-cli/commands/backfill.js";
import * as otlpClient from "../../../src/_core/api/otlp-client.js";

describe("parseCompletedEvent", () => {
  it("returns null for malformed JSON (throws)", () => {
    expect(() => parseCompletedEvent("{not-json")).toThrow();
  });

  it("returns null for non-completed event types", () => {
    const line = JSON.stringify({ type: "response.created", session_id: "s1" });
    expect(parseCompletedEvent(line)).toBeNull();
  });

  it("defaults missing token-count fields to 0", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "session-abc",
      resolvedTimestampNanos: "1700000000000000000",
      data: {
        response: {
          model: "gpt-5",
          usage: {},
        },
      },
    });
    const result = parseCompletedEvent(line);
    expect(result).not.toBeNull();
    expect(result!.inputs).toBe(0);
    expect(result!.outputs).toBe(0);
    expect(result!.cached).toBe(0);
    expect(result!.reasoning).toBe(0);
    expect(result!.toolTokens).toBe(0);
  });

  it("extracts tool_token_count as numeric Long (NOT a tool name string)", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "session-xyz",
      resolvedTimestampNanos: "1700000000000000000",
      data: {
        response: {
          model: "gpt-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            tool_token_count: 12345,
          },
        },
      },
    });
    const result = parseCompletedEvent(line);
    expect(result).not.toBeNull();
    expect(result!.toolTokens).toBe(12345);
    expect(typeof result!.toolTokens).toBe("number");
  });

  it("returns null when timestamp cannot be resolved", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "s1",
      data: { response: { model: "gpt-5", usage: {} } },
    });
    expect(parseCompletedEvent(line)).toBeNull();
  });
});

describe("parseSessionMeta (Codex CLI v0.128.0)", () => {
  it("extracts session id from a real session_meta line", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:27:56.623Z",
      type: "session_meta",
      payload: {
        id: "019def18-c93a-7a50-8a73-eea74e438705",
        cli_version: "0.128.0",
        originator: "codex_cli_rs",
      },
    });
    expect(parseSessionMeta(line)).toEqual({
      sessionId: "019def18-c93a-7a50-8a73-eea74e438705",
      serviceName: "codex_cli_rs",
    });
  });

  it("maps codex_exec originator to codex_exec service.name", () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { id: "session-exec", originator: "codex_exec" },
    });

    expect(parseSessionMeta(line)).toEqual({
      sessionId: "session-exec",
      serviceName: "codex_exec",
    });
  });

  it("returns null for non-session_meta lines", () => {
    expect(parseSessionMeta(JSON.stringify({ type: "turn_context", payload: {} }))).toBeNull();
    expect(parseSessionMeta(JSON.stringify({ type: "event_msg", payload: {} }))).toBeNull();
  });
});

describe("parseTurnContextModel (Codex CLI v0.128.0)", () => {
  it("extracts model from a real turn_context line", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:27:56.624Z",
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-5.3-codex", effort: "medium" },
    });
    expect(parseTurnContextModel(line)).toBe("gpt-5.3-codex");
  });

  it("returns null for other event types", () => {
    expect(
      parseTurnContextModel(JSON.stringify({ type: "session_meta", payload: { id: "x" } })),
    ).toBeNull();
  });
});

describe("parseTokenCountEvent (Codex CLI v0.128.0)", () => {
  const ctx: RolloutContext = {
    sessionId: "session-real",
    model: "gpt-5.3-codex",
    serviceName: "codex_cli_rs",
  };

  it("maps a real event_msg/token_count line using last_token_usage", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:15.013Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 17774,
            cached_input_tokens: 12672,
            output_tokens: 352,
            reasoning_output_tokens: 56,
            total_tokens: 18126,
          },
          total_token_usage: {
            input_tokens: 30894,
            cached_input_tokens: 17664,
            output_tokens: 868,
            reasoning_output_tokens: 209,
            total_tokens: 31762,
          },
          model_context_window: 272000,
        },
      },
    });
    const result = parseTokenCountEvent(line, ctx);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-real");
    expect(result!.serviceName).toBe("codex_cli_rs");
    expect(result!.model).toBe("gpt-5.3-codex");
    expect(result!.inputs).toBe(17774);
    expect(result!.outputs).toBe(352);
    expect(result!.cached).toBe(12672);
    expect(result!.reasoning).toBe(56);
    expect(result!.toolTokens).toBe(0);
  });

  it("returns null for placeholder token_count events whose info is null", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:27:56.754Z",
      type: "event_msg",
      payload: { type: "token_count", info: null },
    });
    expect(parseTokenCountEvent(line, ctx)).toBeNull();
  });

  it("returns null for non-token_count event_msg lines", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message_delta", delta: "hi" },
    });
    expect(parseTokenCountEvent(line, ctx)).toBeNull();
  });

  it("returns null for session_meta and turn_context lines", () => {
    expect(
      parseTokenCountEvent(JSON.stringify({ type: "session_meta", payload: { id: "x" } }), ctx),
    ).toBeNull();
    expect(
      parseTokenCountEvent(JSON.stringify({ type: "turn_context", payload: { model: "m" } }), ctx),
    ).toBeNull();
  });

  it("uses the streaming context's model when info.model is not set", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:15.013Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 2,
          },
        },
      },
    });
    const result = parseTokenCountEvent(line, {
      sessionId: "s",
      model: "ctx-model",
      serviceName: "codex_exec",
    });
    expect(result!.model).toBe("ctx-model");
  });

  it("falls back to 'unknown' model when neither info.model nor ctx.model is set", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:15.013Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 2,
          },
        },
      },
    });
    const result = parseTokenCountEvent(line, {
      sessionId: "s",
      model: "",
      serviceName: "codex_exec",
    });
    expect(result!.model).toBe("unknown");
  });
});

describe("hashTransactionId", () => {
  const sampleEvent: ParsedCodexEvent = {
    sessionId: "session-1",
    serviceName: "codex_exec",
    resolvedTimestampNanos: "1700000000000000000",
    model: "gpt-5",
    inputs: 100,
    outputs: 50,
    cached: 10,
    reasoning: 5,
    toolTokens: 25,
  };

  it("produces 32 hex chars", () => {
    const hash = hashTransactionId(sampleEvent);
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic — same input produces same hash", () => {
    const hash1 = hashTransactionId(sampleEvent);
    const hash2 = hashTransactionId({ ...sampleEvent });
    expect(hash1).toBe(hash2);
  });

  it("uses 8 fields — changing any one component changes the hash", () => {
    const baseline = hashTransactionId(sampleEvent);
    const fields: (keyof ParsedCodexEvent)[] = [
      "sessionId",
      "resolvedTimestampNanos",
      "model",
      "inputs",
      "outputs",
      "cached",
      "reasoning",
      "toolTokens",
    ];
    expect(fields).toHaveLength(8);

    for (const field of fields) {
      const mutated: ParsedCodexEvent = { ...sampleEvent };
      if (typeof mutated[field] === "string") {
        (mutated as Record<string, unknown>)[field] = `${mutated[field]}-x`;
      } else {
        (mutated as Record<string, unknown>)[field] = (mutated[field] as number) + 1;
      }
      expect(hashTransactionId(mutated)).not.toBe(baseline);
    }
  });

  it("differs when toolTokens changes (tool token count is part of hash)", () => {
    const a = hashTransactionId({ ...sampleEvent, toolTokens: 25 });
    const b = hashTransactionId({ ...sampleEvent, toolTokens: 26 });
    expect(a).not.toBe(b);
  });
});

describe("parseDateInput", () => {
  it("parses relative dates (7d)", () => {
    const result = parseDateInput("7d");
    expect(result).toBeInstanceOf(Date);
    const diffDays = (Date.now() - result!.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("parses ISO dates", () => {
    const result = parseDateInput("2025-01-15");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getUTCFullYear()).toBe(2025);
  });

  it("returns null for undefined input", () => {
    expect(parseDateInput(undefined)).toBeNull();
  });
});

describe("backfillAction — date filtering and dry-run", () => {
  let tempSessionsDir: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(otlpClient.sendOtlpLogs).mockClear();

    tempSessionsDir = mkdtempSync(join(tmpdir(), "codex-backfill-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function writeRollouts(lines: string[]): void {
    const subdir = join(tempSessionsDir, "2025", "01");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "rollout-test.jsonl"), lines.join("\n") + "\n");
  }

  /**
   * Build a real-schema Codex CLI v0.128.0 rollout file as 3 newline-joined lines:
   *   1. session_meta (sets sessionId)
   *   2. turn_context (sets model)
   *   3. event_msg / token_count (the row that becomes a backfill event)
   *
   * Returned string is the full file body — caller passes it to writeRollouts directly.
   */
  function makeRolloutBody(
    timestampMs: number,
    sessionId = "s1",
    originator = "codex_cli_rs",
  ): string {
    const ts = new Date(timestampMs).toISOString();
    const sessionMeta = JSON.stringify({
      timestamp: ts,
      type: "session_meta",
      payload: { id: sessionId, cli_version: "0.128.0", originator },
    });
    const turnContext = JSON.stringify({
      timestamp: ts,
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-5.3-codex" },
    });
    const tokenCount = JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 5,
            total_tokens: 165,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 5,
            total_tokens: 165,
          },
          model_context_window: 272000,
        },
      },
    });
    return [sessionMeta, turnContext, tokenCount].join("\n");
  }

  // Legacy alias: behavioural shape is "one event in window" so `makeCompletedEvent`
  // continues to work for the existing date-window tests below.
  function makeCompletedEvent(timestampMs: number, sessionId = "s1"): string {
    return makeRolloutBody(timestampMs, sessionId);
  }

  it("filters events outside the [since, to] window", async () => {
    const now = Date.now();
    const insideWindow = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const outsideWindow = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

    writeRollouts([
      makeCompletedEvent(insideWindow, "session-inside"),
      makeCompletedEvent(outsideWindow, "session-outside"),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    // dry-run, so nothing sent
    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
  });

  it("dry-run mode does not call sendOtlpLogs", async () => {
    const now = Date.now();
    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000)]);

    await backfillAction({
      since: "30d",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
  });

  it("non-dry-run mode calls sendOtlpLogs when events are in window", async () => {
    const now = Date.now();
    writeRollouts([
      makeCompletedEvent(now - 24 * 60 * 60 * 1000, "s-a"),
      makeCompletedEvent(now - 2 * 24 * 60 * 60 * 1000, "s-b"),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).toHaveBeenCalled();
  });

  it("does not send when all events are outside the window", async () => {
    const now = Date.now();
    const ancient = now - 365 * 24 * 60 * 60 * 1000;
    writeRollouts([makeCompletedEvent(ancient)]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
  });

  it("exits on invalid --since (does not silently fall back to default)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      backfillAction({ since: "2025-99-99", dryRun: true, sessionsPath: tempSessionsDir }),
    ).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Invalid --since/);
  });

  it("exits on invalid --to (does not silently fall back to default)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      backfillAction({
        since: "30d",
        to: "not-a-date",
        dryRun: true,
        sessionsPath: tempSessionsDir,
      }),
    ).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Invalid --to/);
  });

  it("exits on NaN --batch-size (does not silently send empty batches)", async () => {
    const now = Date.now();
    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000)]);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      backfillAction({
        since: "30d",
        dryRun: false,
        batchSize: Number.NaN,
        sessionsPath: tempSessionsDir,
      }),
    ).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Invalid --batch-size/);
    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
  });

  it("date-window filter actually drops out-of-window events from sent payload (not vacuous)", async () => {
    const now = Date.now();
    const insideWindow = now - 5 * 24 * 60 * 60 * 1000;
    const outsideWindow = now - 60 * 24 * 60 * 60 * 1000;

    writeRollouts([
      makeCompletedEvent(insideWindow, "session-inside"),
      makeCompletedEvent(outsideWindow, "session-outside"),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    const sessionAttr = records[0].attributes!.find((a) => a.key === "conversation.id");
    expect(sessionAttr?.value.stringValue).toBe("session-inside");
  });

  it("emits CodexCliMapper-compatible token usage OTLP records", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "mapper-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    expect(resourceAttrs.find((a) => a.key === "service.name")?.value.stringValue).toBe(
      "codex_cli_rs",
    );
    expect(payload.resourceLogs[0].scopeLogs[0].scope?.name).toBe("codex_otel.log_only");

    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toBe("codex_cli.token_usage");

    const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
    expect(attrs["conversation.id"]?.stringValue).toBe("mapper-session");
    expect(attrs["model"]?.stringValue).toBe("gpt-5.3-codex");
    expect(attrs["input_token_count"]?.intValue).toBe(100);
    expect(attrs["output_token_count"]?.intValue).toBe(50);
    expect(attrs["cached_token_count"]?.intValue).toBe(10);
    expect(attrs["reasoning_token_count"]?.intValue).toBe(5);
    expect(attrs["tool_token_count"]?.intValue).toBe(0);
    expect(attrs["event.name"]?.stringValue).toBe("codex.sse_event");
    expect(attrs["event.kind"]?.stringValue).toBe("response.completed");
    expect(attrs["session.id"]).toBeUndefined();
    expect(attrs["input_tokens"]).toBeUndefined();
    expect(attrs["output_tokens"]).toBeUndefined();
    expect(attrs["cache_read_tokens"]).toBeUndefined();
    expect(attrs["reasoning_tokens"]).toBeUndefined();
  });

  it("adds setup identity metadata from revenium.env to backfill resource attributes", async () => {
    const now = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), "codex-config-test-"));
    const configPath = join(configDir, "config.toml");
    writeFileSync(
      join(configDir, "revenium.env"),
      [
        "export REVENIUM_API_KEY=hak_test_key",
        "export REVENIUM_SUBSCRIBER_EMAIL=daithi@example.com",
        "export OTEL_RESOURCE_ATTRIBUTES=revenium.api_key=hak_test_key,user.email=daithi%40example.com,organization.name=Default%20Team,product.name=Codex%20CLI",
        "",
      ].join("\n"),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "identity-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      configPath,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    expect(resourceAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
      "daithi@example.com",
    );
    expect(resourceAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe(
      "Default Team",
    );
    expect(resourceAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe(
      "Codex CLI",
    );
    expect(resourceAttrs.find((a) => a.key === "revenium.api_key")).toBeUndefined();
  });

  it("falls back to individual revenium.env identity variables when OTEL_RESOURCE_ATTRIBUTES is absent", async () => {
    const now = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), "codex-config-fallback-test-"));
    const configPath = join(configDir, "config.toml");
    writeFileSync(
      join(configDir, "revenium.env"),
      [
        "export REVENIUM_SUBSCRIBER_EMAIL=fallback@example.com",
        "export REVENIUM_ORGANIZATION_NAME=Fallback Org",
        "export REVENIUM_PRODUCT_NAME=Fallback Product",
        "",
      ].join("\n"),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "fallback-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      configPath,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    expect(resourceAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
      "fallback@example.com",
    );
    expect(resourceAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe(
      "Fallback Org",
    );
    expect(resourceAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe(
      "Fallback Product",
    );
  });

  it("falls back to parseCompletedEvent for legacy response.completed rollouts", async () => {
    const now = Date.now();
    const ts = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const tsNanos = (BigInt(new Date(ts).getTime()) * BigInt(1_000_000)).toString();
    const legacyLine = JSON.stringify({
      type: "response.completed",
      session_id: "legacy-session",
      resolvedTimestampNanos: tsNanos,
      data: {
        response: {
          model: "gpt-5",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            reasoning_tokens: 0,
            tool_token_count: 0,
          },
        },
      },
    });
    const subdir = join(tempSessionsDir, "legacy");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "rollout-legacy.jsonl"), legacyLine + "\n");

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    expect(otlpClient.sendOtlpLogs).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    const sessionAttr = records[0].attributes!.find((a) => a.key === "conversation.id");
    expect(sessionAttr?.value.stringValue).toBe("legacy-session");
  });
});
