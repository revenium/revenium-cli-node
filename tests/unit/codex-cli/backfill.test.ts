import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/codex-cli/config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/codex-cli/config/loader.js")>();
  return {
    ...actual,
    readCodexToml: vi.fn().mockResolvedValue('[otel]\nendpoint = "https://api.revenium.ai"\n'),
    resolveOtelCredentials: vi.fn().mockResolvedValue({
      endpoint: "https://api.revenium.ai",
      apiKey: "hak_test_key",
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/_core/api/resilience.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/_core/api/resilience.js")>();
  return { ...actual, startupStagger: vi.fn().mockResolvedValue(undefined) };
});

import {
  parseCompletedEvent,
  parseSessionMeta,
  parseTurnContext,
  parseTurnContextModel,
  parseTokenCountEvent,
  hashTransactionId,
  deduplicateCodexEvents,
  parseDateInput,
  backfillAction,
  type ParsedCodexEvent,
  type RolloutContext,
} from "../../../src/codex-cli/commands/backfill.js";
import * as otlpClient from "../../../src/_core/api/otlp-client.js";
import * as loaderModule from "../../../src/codex-cli/config/loader.js";
import { buildCodexEnv, loadCodexAttribution } from "../../../src/codex-cli/config/env.js";

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
    expect(result!.totalTokens).toBe(0);
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
    expect(result!.totalTokens).toBe(12345);
    expect(typeof result!.totalTokens).toBe("number");
  });

  it("returns null when timestamp cannot be resolved", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "s1",
      data: { response: { model: "gpt-5", usage: {} } },
    });
    expect(parseCompletedEvent(line)).toBeNull();
  });

  it("sets a timestamp-based dedupeKey even with a rollout context", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "session-abc",
      resolvedTimestampNanos: "1700000000000000000",
      data: { response: { model: "gpt-5", usage: {} } },
    });
    const ctx: RolloutContext = {
      sessionId: "session-abc",
      model: "gpt-5",
      serviceName: "codex_cli_rs",
      projectPath: "/Users/dev/acme",
    };
    const result = parseCompletedEvent(line, ctx);
    expect(result!.dedupeKey).toBe(
      "codex-completed-value|codex_cli_rs|session-abc|1700000000000000000",
    );
  });

  it("falls back to the rollout context session id when the line carries none", () => {
    const line = JSON.stringify({
      type: "response.completed",
      resolvedTimestampNanos: "1700000000000000000",
      data: { response: { model: "gpt-5", usage: { input_tokens: 10 } } },
    });
    const ctx: RolloutContext = {
      sessionId: "session-from-meta",
      model: "gpt-5",
      serviceName: "codex_cli_rs",
      projectPath: "/Users/dev/acme",
    };
    const result = parseCompletedEvent(line, ctx);
    expect(result!.sessionId).toBe("session-from-meta");
    expect(result!.dedupeKey).toBe(
      "codex-completed-value|codex_cli_rs|session-from-meta|1700000000000000000",
    );
  });

  it("sets timestamp-based dedupeKey without a rollout context", () => {
    const line = JSON.stringify({
      type: "response.completed",
      session_id: "session-abc",
      resolvedTimestampNanos: "1700000000000000000",
      data: { response: { model: "gpt-5", usage: {} } },
    });
    const result = parseCompletedEvent(line);
    expect(result!.dedupeKey).toContain("codex-completed-value");
    expect(result!.dedupeKey).toContain("1700000000000000000");
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
        cwd: "/Users/dev/clientA-app",
      },
    });
    expect(parseSessionMeta(line)).toEqual({
      sessionId: "019def18-c93a-7a50-8a73-eea74e438705",
      serviceName: "codex_cli_rs",
      projectPath: "/Users/dev/clientA-app",
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
      projectPath: "unknown",
    });
  });

  it("returns null for non-session_meta lines", () => {
    expect(parseSessionMeta(JSON.stringify({ type: "turn_context", payload: {} }))).toBeNull();
    expect(parseSessionMeta(JSON.stringify({ type: "event_msg", payload: {} }))).toBeNull();
  });
});

describe("parseTurnContextModel (Codex CLI v0.128.0)", () => {
  it("returns only the model from a real turn_context line", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:27:56.624Z",
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-5.3-codex", effort: "medium" },
    });

    expect(parseTurnContext(line)).toEqual({ model: "gpt-5.3-codex" });
  });

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
    projectPath: "/Users/dev/acme",
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
    expect(result!.totalTokens).toBe(18126);
    expect(result!.callKey).toBe(
      "codex-call|codex_cli_rs|session-real|gpt-5.3-codex|30894|868|17664|209|31762|17774|352|12672|56|18126",
    );
  });

  it("maps cache-write tokens reported by Codex 0.161 and later", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:15.013Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 12000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 12000,
            output_tokens: 300,
            reasoning_output_tokens: 100,
            total_tokens: 12300,
          },
        },
      },
    });
    const result = parseTokenCountEvent(line, ctx);
    expect(result!.cacheWrite).toBe(12000);
    expect(result!.inputs).toBe(12000);
  });

  it("reports no cache-write tokens for rollouts recorded before Codex 0.161", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-03T18:28:15.013Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 12000,
            cached_input_tokens: 0,
            output_tokens: 300,
            reasoning_output_tokens: 100,
            total_tokens: 12300,
          },
        },
      },
    });
    expect(parseTokenCountEvent(line, ctx)!.cacheWrite).toBe(0);
  });

  it("keeps the transaction id identical whether or not cache-write tokens are reported", () => {
    const makeLine = (withCacheWrite: boolean): string =>
      JSON.stringify({
        timestamp: "2026-05-03T18:28:15.013Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 0,
              output_tokens: 300,
              reasoning_output_tokens: 100,
              total_tokens: 12300,
              ...(withCacheWrite ? { cache_write_input_tokens: 12000 } : {}),
            },
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 0,
              output_tokens: 300,
              reasoning_output_tokens: 100,
              total_tokens: 12300,
            },
          },
        },
      });

    const withCacheWrite = parseTokenCountEvent(makeLine(true), ctx)!;
    const withoutCacheWrite = parseTokenCountEvent(makeLine(false), ctx)!;

    expect(hashTransactionId(withCacheWrite)).toBe(hashTransactionId(withoutCacheWrite));
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
      projectPath: "/Users/dev/acme",
    });
    expect(result!.model).toBe("ctx-model");
  });

  it("keys on the timestamp when total_token_usage is absent", () => {
    const makeLine = (timestamp: string): string =>
      JSON.stringify({
        timestamp,
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

    const first = parseTokenCountEvent(makeLine("2026-05-03T18:28:15.013Z"), ctx);
    const second = parseTokenCountEvent(makeLine("2026-05-03T18:28:16.013Z"), ctx);

    expect(first!.callKey).toContain(first!.resolvedTimestampNanos);
    expect(first!.callKey).not.toBe(second!.callKey);
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
      projectPath: "/Users/dev/acme",
    });
    expect(result!.model).toBe("unknown");
  });
});

describe("hashTransactionId", () => {
  const sampleEvent: ParsedCodexEvent = {
    sessionId: "session-1",
    serviceName: "codex_exec",
    projectPath: "/Users/dev/acme",
    resolvedTimestampNanos: "1700000000000000000",
    model: "gpt-5",
    inputs: 100,
    outputs: 50,
    cached: 10,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: 25,
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

  it("uses 8 fields without a call key — changing any one component changes the hash", () => {
    const baseline = hashTransactionId(sampleEvent);
    const fields: (keyof ParsedCodexEvent)[] = [
      "sessionId",
      "resolvedTimestampNanos",
      "model",
      "inputs",
      "outputs",
      "cached",
      "reasoning",
      "totalTokens",
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

  it("ignores the local dedupe key of legacy events", () => {
    const withoutKey = hashTransactionId(sampleEvent);
    const withKey = hashTransactionId({
      ...sampleEvent,
      dedupeKey: "codex-completed-value|codex_exec|session-1|1700000000000000000",
    });

    expect(withKey).toBe(withoutKey);
  });

  it("differs when totalTokens changes (total token count is part of hash)", () => {
    const a = hashTransactionId({ ...sampleEvent, totalTokens: 25 });
    const b = hashTransactionId({ ...sampleEvent, totalTokens: 26 });
    expect(a).not.toBe(b);
  });

  it("keeps transaction_id stable across snapshots of the same call", () => {
    const a = hashTransactionId({
      ...sampleEvent,
      resolvedTimestampNanos: "1700000000000000000",
      callKey: "codex-call|codex_cli_rs|session-1|gpt-5|100|50|10|5|165|100|50|10|5|165",
    });
    const b = hashTransactionId({
      ...sampleEvent,
      resolvedTimestampNanos: "1700000001000000000",
      callKey: "codex-call|codex_cli_rs|session-1|gpt-5|100|50|10|5|165|100|50|10|5|165",
    });

    expect(a).toBe(b);
  });

  it("separates calls that differ only by cumulative usage", () => {
    const first = hashTransactionId({
      ...sampleEvent,
      callKey: "codex-call|codex_cli_rs|session-1|gpt-5|100|50|10|5|165|100|50|10|5|165",
    });
    const second = hashTransactionId({
      ...sampleEvent,
      callKey: "codex-call|codex_cli_rs|session-1|gpt-5|200|100|20|10|330|100|50|10|5|165",
    });

    expect(first).not.toBe(second);
  });
});

describe("deduplicateCodexEvents", () => {
  const baseEvent: ParsedCodexEvent = {
    sessionId: "session-1",
    serviceName: "codex_cli_rs",
    projectPath: "/Users/dev/acme",
    resolvedTimestampNanos: "1700000000000000000",
    model: "gpt-5",
    inputs: 100,
    outputs: 50,
    cached: 10,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: 0,
    callKey: "codex-call|codex_cli_rs|session-1|gpt-5|100|50|10|5|165|100|50|10|5|165",
  };

  it("keeps distinct calls in the same turn as separate records", () => {
    const secondCall = {
      ...baseEvent,
      resolvedTimestampNanos: "1700000001000000000",
      inputs: 150,
      outputs: 30,
      cached: 5,
      reasoning: 15,
      callKey: "codex-call|codex_cli_rs|session-1|gpt-5|250|80|15|20|365|150|30|5|15|200",
    };

    const result = deduplicateCodexEvents([baseEvent, secondCall]);

    expect(result.duplicateCount).toBe(0);
    expect(result.events).toHaveLength(2);
  });

  it("collapses a repeated token_count snapshot and keeps the first event's figures", () => {
    const repeated = { ...baseEvent, resolvedTimestampNanos: "1700000001000000000" };

    const result = deduplicateCodexEvents([baseEvent, repeated]);

    expect(result.duplicateCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].inputs).toBe(100);
    expect(result.events[0].outputs).toBe(50);
    expect(result.events[0].cached).toBe(10);
    expect(result.events[0].reasoning).toBe(5);
    expect(result.events[0].resolvedTimestampNanos).toBe("1700000000000000000");
  });

  it("gives the same transaction_id to a call retained from overlapping date windows", () => {
    const earlierSnapshot = baseEvent;
    const laterSnapshot = { ...baseEvent, resolvedTimestampNanos: "1700000001000000000" };

    const wideWindow = deduplicateCodexEvents([earlierSnapshot, laterSnapshot]);
    const narrowWindow = deduplicateCodexEvents([laterSnapshot]);

    expect(hashTransactionId(wideWindow.events[0])).toBe(hashTransactionId(narrowWindow.events[0]));
  });

  it("does not collapse legacy events without a key", () => {
    const first = { ...baseEvent, callKey: undefined };
    const second = {
      ...baseEvent,
      resolvedTimestampNanos: "1700000001000000000",
      callKey: undefined,
    };

    const result = deduplicateCodexEvents([first, second]);

    expect(result.duplicateCount).toBe(0);
    expect(result.events).toHaveLength(2);
  });

  it("does not collapse call events when cumulative totals differ", () => {
    const first = {
      ...baseEvent,
      callKey: "codex-call|svc|session-1|gpt-5|100|50|10|5|150|100|50|10|5|150",
    };
    const second = {
      ...baseEvent,
      resolvedTimestampNanos: "1700000001000000000",
      callKey: "codex-call|svc|session-1|gpt-5|200|100|20|10|300|100|50|10|5|150",
    };

    const result = deduplicateCodexEvents([first, second]);

    expect(result.duplicateCount).toBe(0);
    expect(result.events).toHaveLength(2);
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
  let tempDirs: string[];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(otlpClient.sendOtlpLogs).mockClear();

    tempDirs = [];
    tempSessionsDir = makeTempDir("codex-backfill-test-");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
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
    cacheWriteTokens = 0,
    cwd?: string,
  ): string {
    const ts = new Date(timestampMs).toISOString();
    const sessionMeta = JSON.stringify({
      timestamp: ts,
      type: "session_meta",
      payload: { id: sessionId, cli_version: "0.128.0", originator, cwd },
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
            ...(cacheWriteTokens > 0 ? { cache_write_input_tokens: cacheWriteTokens } : {}),
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

  function makeMultiCallRollout(timestampMs: number, sessionId: string): string {
    const sessionMeta = JSON.stringify({
      timestamp: new Date(timestampMs).toISOString(),
      type: "session_meta",
      payload: { id: sessionId, cli_version: "0.128.0", originator: "codex_cli_rs" },
    });
    const turnContext = JSON.stringify({
      timestamp: new Date(timestampMs).toISOString(),
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-5.3-codex" },
    });

    const calls = [
      { input: 1000, cached: 100, output: 200, reasoning: 20 },
      { input: 1500, cached: 150, output: 300, reasoning: 30 },
      { input: 2200, cached: 220, output: 400, reasoning: 40 },
    ];

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    const tokenCounts = calls.map((call, index) => {
      cumulativeInput += call.input;
      cumulativeOutput += call.output;
      return JSON.stringify({
        timestamp: new Date(timestampMs + index * 1_000).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: call.input,
              cached_input_tokens: call.cached,
              output_tokens: call.output,
              reasoning_output_tokens: call.reasoning,
              total_tokens: call.input + call.output,
            },
            total_token_usage: {
              input_tokens: cumulativeInput,
              output_tokens: cumulativeOutput,
              total_tokens: cumulativeInput + cumulativeOutput,
            },
            model_context_window: 272000,
          },
        },
      });
    });

    return [sessionMeta, turnContext, ...tokenCounts].join("\n");
  }

  function makeCompletedLine(timestampMs: number, sessionId = "s1"): string {
    return JSON.stringify({
      type: "response.completed",
      session_id: sessionId,
      resolvedTimestampNanos: (BigInt(timestampMs) * BigInt(1_000_000)).toString(),
      data: {
        response: {
          model: "gpt-5.3-codex",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            reasoning_tokens: 1,
            tool_token_count: 0,
          },
        },
      },
    });
  }

  function makeTokenCountLine(
    timestampMs: number,
    usage: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
    },
  ): string {
    return JSON.stringify({
      timestamp: new Date(timestampMs).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: usage,
          total_token_usage: usage,
          model_context_window: 272000,
        },
      },
    });
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

  it("reads the sessions folder under CODEX_HOME when no --sessions-path is given", async () => {
    const codexHome = makeTempDir("codex-home-");
    const subdir = join(codexHome, "sessions", "2026", "09");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      join(subdir, "rollout-relocated.jsonl"),
      makeCompletedEvent(Date.parse("2026-09-15T10:00:00Z"), "relocated-session") + "\n",
    );
    vi.stubEnv("CODEX_HOME", codexHome);

    await backfillAction({ since: "2026-09-01", to: "2026-09-30", dryRun: true });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain(join(codexHome, "sessions"));
    expect(printed).toContain("Events selected: 1");
  });

  it("lets --sessions-path beat a set CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", makeTempDir("codex-home-ignored-"));
    writeRollouts([makeCompletedEvent(Date.parse("2026-09-15T10:00:00Z"), "flag-session")]);

    await backfillAction({
      since: "2026-09-01",
      to: "2026-09-30",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain(tempSessionsDir);
    expect(printed).toContain("Events selected: 1");
  });

  it("keeps an event stamped during the day named by a date-only --to", async () => {
    writeRollouts([makeCompletedEvent(Date.parse("2026-09-30T15:00:01Z"), "last-day-session")]);

    await backfillAction({
      since: "2026-09-01",
      to: "2026-09-30",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("Events selected: 1");
    expect(printed).not.toContain("No matching events found.");
  });

  it("prints a window ending at the last millisecond of a date-only --to", async () => {
    writeRollouts([makeCompletedEvent(Date.parse("2026-09-30T15:00:01Z"), "window-session")]);

    await backfillAction({
      since: "2026-09-01",
      to: "2026-09-30",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("Date window: 2026-09-01T00:00:00.000Z -> 2026-09-30T23:59:59.999Z");
  });

  it("ends the window at the exact instant of a --to carrying a time", async () => {
    writeRollouts([
      makeCompletedEvent(Date.parse("2026-09-30T15:00:01Z"), "after-instant-session"),
    ]);

    await backfillAction({
      since: "2026-09-01",
      to: "2026-09-30T12:00:00Z",
      dryRun: true,
      sessionsPath: tempSessionsDir,
    });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("-> 2026-09-30T12:00:00.000Z");
    expect(printed).toContain("No matching events found.");
  });

  it("leaves no gap and no overlap between consecutive month windows", async () => {
    writeRollouts([
      makeCompletedEvent(Date.parse("2026-09-30T23:59:59.999Z"), "september-session"),
      makeCompletedEvent(Date.parse("2026-10-01T00:00:00.000Z"), "october-session"),
    ]);

    const conversationIdsSentFor = async (since: string, to: string): Promise<string[]> => {
      vi.mocked(otlpClient.sendOtlpLogs).mockClear();
      await backfillAction({ since, to, dryRun: false, sessionsPath: tempSessionsDir });
      return vi
        .mocked(otlpClient.sendOtlpLogs)
        .mock.calls.flatMap(([, , payload]) =>
          payload.resourceLogs[0].scopeLogs[0].logRecords.map(
            (record) =>
              record.attributes.find((attribute) => attribute.key === "conversation.id")?.value
                .stringValue as string,
          ),
        );
    };

    expect(await conversationIdsSentFor("2026-09-01", "2026-09-30")).toEqual(["september-session"]);
    expect(await conversationIdsSentFor("2026-10-01", "2026-10-31")).toEqual(["october-session"]);
  });

  describe("which projects an import carries", () => {
    const CLIENT_A = "/Users/dev/clientA-app";
    const CLIENT_B = "/Users/dev/clientB-app";
    const now = Date.parse("2026-09-15T10:00:00Z");

    function writeTwoClients(): void {
      writeRollouts([
        makeRolloutBody(now, "sess-clientA", "codex_cli_rs", 0, CLIENT_A),
        makeRolloutBody(now, "sess-clientB", "codex_cli_rs", 0, CLIENT_B),
      ]);
    }

    async function run(options: { project?: string; excludeProject?: string }): Promise<string[]> {
      await backfillAction({
        since: "2026-09-01",
        to: "2026-09-30",
        sessionsPath: tempSessionsDir,
        ...options,
      });
      return vi
        .mocked(otlpClient.sendOtlpLogs)
        .mock.calls.flatMap(([, , payload]) =>
          payload.resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) =>
              scope.logRecords.map(
                (record) =>
                  record.attributes.find((attribute) => attribute.key === "conversation.id")?.value
                    .stringValue as string,
              ),
            ),
          ),
        );
    }

    it("names every project it found, with an event count, before anything is sent", async () => {
      writeTwoClients();

      await backfillAction({
        since: "2026-09-01",
        to: "2026-09-30",
        dryRun: true,
        sessionsPath: tempSessionsDir,
      });

      const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(printed).toContain("Projects:");
      expect(printed).toContain(`${CLIENT_A}  1 event(s)`);
      expect(printed).toContain(`${CLIENT_B}  1 event(s)`);
      expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
    });

    it("names the project it sent, with an event count, on a run that is not a preview", async () => {
      writeTwoClients();

      await run({ project: "clientA-app" });

      const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(printed).toContain("Projects:");
      expect(printed).toContain(`${CLIENT_A}  1 event(s)`);
      expect(otlpClient.sendOtlpLogs).toHaveBeenCalled();
    });

    it("marks the projects it is leaving out in the listing it prints", async () => {
      writeTwoClients();

      await run({ project: "clientA-app" });

      const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(printed).toContain(`${CLIENT_B}  1 event(s)  excluded`);
    });

    it("sends no session of another client's project when the import names one project", async () => {
      writeTwoClients();

      expect(await run({ project: "clientA-app" })).toEqual(["sess-clientA"]);
    });

    it("sends no session of an excluded project", async () => {
      writeTwoClients();

      expect(await run({ excludeProject: CLIENT_B })).toEqual(["sess-clientA"]);
    });

    it("sends every project when neither option is given", async () => {
      writeTwoClients();

      expect(await run({})).toEqual(expect.arrayContaining(["sess-clientA", "sess-clientB"]));
    });

    it("sends nothing and exits 1 when the named project matches none", async () => {
      writeTwoClients();

      await run({ project: "clientC-app" });

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
    });

    it("exits 1 when the excluded project matches none", async () => {
      writeTwoClients();

      await run({ excludeProject: "clientC-app" });

      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("sends no client's events when the named folder belongs to more than one project", async () => {
      writeRollouts([
        makeRolloutBody(now, "sess-clientA-web", "codex_cli_rs", 0, `${CLIENT_A}/apps/web`),
        makeRolloutBody(now, "sess-clientB-web", "codex_cli_rs", 0, `${CLIENT_B}/apps/web`),
      ]);
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("__exit__");
      }) as never);

      await expect(run({ project: "web" })).rejects.toThrow("__exit__");

      expect(exit).toHaveBeenCalledWith(1);
      expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
    });

    it("sends no session run from a subdirectory of an excluded project", async () => {
      writeRollouts([
        makeRolloutBody(now, "sess-clientA", "codex_cli_rs", 0, CLIENT_A),
        makeRolloutBody(now, "sess-clientB-api", "codex_cli_rs", 0, `${CLIENT_B}/packages/api`),
      ]);

      expect(await run({ excludeProject: CLIENT_B })).toEqual(["sess-clientA"]);
    });

    it("sends nothing when every project it found is excluded", async () => {
      writeTwoClients();

      expect(await run({ excludeProject: `${CLIENT_A},${CLIENT_B}` })).toEqual([]);
    });
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

  it("sends one record per model call within a turn", async () => {
    const now = Date.now();
    writeRollouts([makeMultiCallRollout(now - 24 * 60 * 60 * 1000, "multi-call-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(3);

    const usagePerRecord = records.map((record) => {
      const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
      return {
        inputs: attrs["input_token_count"]?.intValue,
        outputs: attrs["output_token_count"]?.intValue,
        cached: attrs["cached_token_count"]?.intValue,
        reasoning: attrs["reasoning_token_count"]?.intValue,
      };
    });

    expect(usagePerRecord).toEqual([
      { inputs: 1000, outputs: 200, cached: 100, reasoning: 20 },
      { inputs: 1500, outputs: 300, cached: 150, reasoning: 30 },
      { inputs: 2200, outputs: 400, cached: 220, reasoning: 40 },
    ]);
    expect(usagePerRecord.reduce((sum, usage) => sum + (usage.inputs ?? 0), 0)).toBe(4700);
    expect(usagePerRecord.reduce((sum, usage) => sum + (usage.outputs ?? 0), 0)).toBe(900);
  });

  it("collapses a token_count line repeated with identical cumulative and last usage", async () => {
    const now = Date.now() - 24 * 60 * 60 * 1000;
    const body = makeRolloutBody(now, "repeat-session");
    const repeated = makeTokenCountLine(now + 1_000, {
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 50,
      reasoning_output_tokens: 5,
      total_tokens: 165,
    });
    writeRollouts([[body, repeated].join("\n")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    expect(records[0].timeUnixNano).toBe((BigInt(now) * BigInt(1_000_000)).toString());
    expect(records[0].attributes.find((a) => a.key === "input_token_count")?.value.intValue).toBe(
      100,
    );
  });

  it("sends only token_count records for a rollout file carrying both schemas", async () => {
    const now = Date.now() - 24 * 60 * 60 * 1000;
    const firstTurn = makeRolloutBody(now, "mixed-schema-session");
    const completed = makeCompletedLine(now + 500, "mixed-schema-session");
    const laterTokenCount = makeTokenCountLine(now + 1_000, {
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 50,
      reasoning_output_tokens: 5,
      total_tokens: 150,
    });
    writeRollouts([[firstTurn, completed, laterTokenCount].join("\n")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const records = payload.resourceLogs.flatMap((resourceLog) =>
      resourceLog.scopeLogs.flatMap((scopeLog) => scopeLog.logRecords),
    );

    expect(records).toHaveLength(2);

    const inputsPerRecord = records.map(
      (r) => r.attributes.find((a) => a.key === "input_token_count")?.value.intValue,
    );
    expect(inputsPerRecord).toEqual([100, 100]);
    expect(inputsPerRecord).not.toContain(10);
  });

  it("suppresses legacy records for a token_count file even when the token_count line is outside the window", async () => {
    const now = Date.now();
    const insideWindow = now - 24 * 60 * 60 * 1000;
    const outsideWindow = now - 60 * 24 * 60 * 60 * 1000;

    writeRollouts([
      [
        makeRolloutBody(outsideWindow, "window-scoped-session"),
        makeCompletedLine(insideWindow, "window-scoped-session"),
      ].join("\n"),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
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
    expect(attrs["cache_write_token_count"]?.intValue).toBe(0);
    expect(attrs["reasoning_token_count"]?.intValue).toBe(5);
    expect(attrs["tool_token_count"]?.intValue).toBe(165);
    expect(attrs["event.name"]?.stringValue).toBe("codex.sse_event");
    expect(attrs["event.kind"]?.stringValue).toBe("response.completed");
    expect(attrs["session.id"]).toBeUndefined();
    expect(attrs["input_tokens"]).toBeUndefined();
    expect(attrs["output_tokens"]).toBeUndefined();
    expect(attrs["cache_read_tokens"]).toBeUndefined();
    expect(attrs["reasoning_tokens"]).toBeUndefined();
  });

  it("sends the cache-write token count reported by the rollout", async () => {
    const now = Date.now();

    writeRollouts([
      makeRolloutBody(now - 24 * 60 * 60 * 1000, "cache-write-session", "codex_cli_rs", 12000),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
    expect(attrs["cache_write_token_count"]?.intValue).toBe(12000);
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
    const logRecordAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes!;
    expect(resourceAttrs.find((a) => a.key === "user.email")).toBeUndefined();
    expect(logRecordAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
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

  it("keeps a single backfill source marker when revenium.env carries a live one", async () => {
    const now = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), "codex-config-source-test-"));
    const configPath = join(configDir, "config.toml");
    writeFileSync(
      join(configDir, "revenium.env"),
      [
        "export OTEL_RESOURCE_ATTRIBUTES=revenium.middleware.source=revenium-cli,product.name=Codex%20CLI",
        "",
      ].join("\n"),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "source-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      configPath,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    const sourceAttrs = resourceAttrs.filter((a) => a.key === "revenium.middleware.source");
    expect(sourceAttrs).toHaveLength(1);
    expect(sourceAttrs[0].value.stringValue).toBe("revenium-cli-backfill");
  });

  it("attributes from the raw revenium.env identity variables", async () => {
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
    const logRecordAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes!;
    expect(resourceAttrs.find((a) => a.key === "user.email")).toBeUndefined();
    expect(logRecordAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
      "fallback@example.com",
    );
    expect(resourceAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe(
      "Fallback Org",
    );
    expect(resourceAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe(
      "Fallback Product",
    );
  });

  it("sends a name carrying attribute delimiters in the same encoded form as a live session", async () => {
    const now = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), "codex-config-delimiters-test-"));
    const configPath = join(configDir, "config.toml");
    writeFileSync(
      join(configDir, "revenium.env"),
      ["REVENIUM_ORGANIZATION_NAME='Acme, Inc.'", "REVENIUM_PRODUCT_NAME='R=D 100%'", ""].join(
        "\n",
      ),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "delimiters-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      configPath,
    });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    expect(resourceAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe(
      "Acme%2C Inc.",
    );
    expect(resourceAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe(
      "R%3DD 100%25",
    );
  });

  it("attributes a live session and a backfill of the same machine identically", async () => {
    const now = Date.now();
    const configDir = mkdtempSync(join(tmpdir(), "codex-config-parity-test-"));
    const configPath = join(configDir, "config.toml");
    writeFileSync(
      join(configDir, "revenium.env"),
      ["REVENIUM_ORGANIZATION_NAME='Acme, Inc.'", "REVENIUM_PRODUCT_NAME='R=D 100%'", ""].join(
        "\n",
      ),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "parity-session")]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      configPath,
    });

    const attribution = await loadCodexAttribution(configPath);
    const live = buildCodexEnv(attribution!).OTEL_RESOURCE_ATTRIBUTES;
    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const backfilled = Object.fromEntries(
      payload.resourceLogs[0].resource!.attributes!.map((a) => [a.key, a.value.stringValue]),
    );

    expect(live).toContain(`organization.name=${backfilled["organization.name"]}`);
    expect(live).toContain(`product.name=${backfilled["product.name"]}`);
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

  it("declares the backfill ingest channel on the resource, not on the log record", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "channel-session")]);

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource!.attributes!;
    const logRecordAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes!;
    expect(
      resourceAttrs.find((a) => a.key === "revenium.middleware.source")?.value.stringValue,
    ).toBe("revenium-cli-backfill");
    expect(logRecordAttrs.find((a) => a.key === "revenium.middleware.source")).toBeUndefined();
  });

  it("reports the call's total tokens as tool_token_count", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "total-tokens-session")]);

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const attrs = Object.fromEntries(
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a) => [a.key, a.value]),
    );
    expect(attrs["tool_token_count"]?.intValue).toBe(165);
  });

  it("pins the transaction_id so a re-run over rollouts imported by an earlier version sends no new spend", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "hash-stability-session")]);

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const attrs = Object.fromEntries(
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a) => [a.key, a.value]),
    );
    expect(attrs["transaction_id"]?.stringValue).toBe("dec31dd23c0175558a19200530b6c0d4");
  });

  it("does not promise server-side dedup when sending fails", async () => {
    const now = Date.now();
    vi.mocked(otlpClient.sendOtlpLogs).mockRejectedValueOnce(new Error("network down"));

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "failure-session")]);

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("the transaction_id it already had");
    expect(printed).not.toContain("safe to re-run");
    expect(printed).not.toContain("does not add rows");
  });

  it("warns that calls already exported live are imported a second time", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "overlap-session")]);

    await backfillAction({ since: "30d", dryRun: true, sessionsPath: tempSessionsDir });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("imported again as a second record");
  });

  it("warns about the live overlap before reading any rollout, even when the window is empty", async () => {
    const now = Date.now();

    writeRollouts([makeCompletedEvent(now - 365 * 24 * 60 * 60 * 1000, "ancient-session")]);

    await backfillAction({ since: "30d", dryRun: false, sessionsPath: tempSessionsDir });

    const logSpy = vi.mocked(console.log);
    const warningIndex = logSpy.mock.calls.findIndex((call) =>
      call.join(" ").includes("imported again as a second record"),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();

    const readdirMock = vi.mocked(readdir);
    expect(readdirMock.mock.invocationCallOrder.length).toBeGreaterThan(0);
    expect(logSpy.mock.invocationCallOrder[warningIndex]).toBeLessThan(
      readdirMock.mock.invocationCallOrder[0],
    );
  });

  it("still warns about past live export when the exporter is off today", async () => {
    const now = Date.now();
    vi.mocked(loaderModule.readCodexToml).mockResolvedValueOnce(
      ["[otel]", 'exporter = "none"', 'metrics_exporter = "none"', ""].join("\n"),
    );

    writeRollouts([makeCompletedEvent(now - 24 * 60 * 60 * 1000, "opt-out-session")]);

    await backfillAction({ since: "30d", dryRun: true, sessionsPath: tempSessionsDir });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("Live export is off in the current config");
    expect(printed).toContain("imported again as a second record");
    expect(printed).not.toContain("Codex exports usage to Revenium as calls happen");
  });

  it("does not promise server-side dedup when interrupted mid-import", async () => {
    const now = Date.now();
    vi.mocked(otlpClient.sendOtlpLogs).mockImplementationOnce(async () => {
      process.emit("SIGINT");
    });

    writeRollouts([
      makeCompletedEvent(now - 24 * 60 * 60 * 1000, "interrupt-session-a"),
      makeCompletedEvent(now - 23 * 60 * 60 * 1000, "interrupt-session-b"),
    ]);

    await backfillAction({
      since: "30d",
      dryRun: false,
      sessionsPath: tempSessionsDir,
      batchSize: 1,
    });

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("Backfill interrupted at batch 2/2");
    expect(printed).toContain("the transaction_id it already had");
    expect(printed).not.toContain("safe to re-run");
  });
});
