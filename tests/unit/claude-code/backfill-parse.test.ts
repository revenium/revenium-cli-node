import { describe, it, expect } from "vitest";
import { createOtlpPayload, parseJsonlLine } from "../../../src/claude-code/commands/backfill.js";

function makeJsonlLine(
  usage: Record<string, unknown>,
  entry: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    requestId: "req_123",
    sessionId: "session-abc",
    timestamp: "2024-06-01T12:00:00.000Z",
    ...entry,
    message: {
      id: "msg_123",
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage,
    },
  });
}

describe("parseJsonlLine", () => {
  it("extracts the cache-write TTL split and speed from a session line", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 1000,
      cache_creation: {
        ephemeral_1h_input_tokens: 200,
        ephemeral_5m_input_tokens: 800,
      },
      speed: "Fast",
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.cacheCreationTokens).toBe(1000);
    expect(record?.cacheCreation1hTokens).toBe(200);
    expect(record?.cacheCreation5mTokens).toBe(800);
    expect(record?.speed).toBe("fast");
  });

  it("extracts the inference region, the web-search count and the call's cost", () => {
    const line = makeJsonlLine(
      {
        input_tokens: 100,
        output_tokens: 50,
        inference_geo: "US",
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
      },
      { costUSD: 0.1234567 },
    );

    const { record } = parseJsonlLine(line, null);

    expect(record?.inferenceGeo).toBe("us");
    expect(record?.webSearchRequests).toBe(3);
    expect(record?.costUsd).toBe(0.1234567);
  });

  it("treats a malformed region, search count or cost as absent", () => {
    const line = makeJsonlLine(
      {
        input_tokens: 100,
        output_tokens: 50,
        inference_geo: 7,
        server_tool_use: { web_search_requests: -1 },
      },
      { costUSD: "0.5" },
    );

    const { record } = parseJsonlLine(line, null);

    expect(record?.inferenceGeo).toBeUndefined();
    expect(record?.webSearchRequests).toBeUndefined();
    expect(record?.costUsd).toBeUndefined();
  });

  it("leaves a zero cost out so the price is derived from the tokens", () => {
    const line = makeJsonlLine({ input_tokens: 100, output_tokens: 50 }, { costUSD: 0 });

    const { record } = parseJsonlLine(line, null);

    expect(record?.costUsd).toBeUndefined();
  });

  it("leaves the split and speed undefined when the session line omits them", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 1000,
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.cacheCreationTokens).toBe(1000);
    expect(record?.cacheCreation1hTokens).toBeUndefined();
    expect(record?.cacheCreation5mTokens).toBeUndefined();
    expect(record?.speed).toBeUndefined();
    expect(record?.inferenceGeo).toBeUndefined();
    expect(record?.webSearchRequests).toBeUndefined();
    expect(record?.costUsd).toBeUndefined();
  });

  it("treats a malformed cache_creation value as absent", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 1000,
      cache_creation: "ephemeral",
      speed: "   ",
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.cacheCreation1hTokens).toBeUndefined();
    expect(record?.cacheCreation5mTokens).toBeUndefined();
    expect(record?.speed).toBeUndefined();
  });

  it("drops a bucket that is not a whole token count", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 1000,
      cache_creation: {
        ephemeral_1h_input_tokens: 1.5,
        ephemeral_5m_input_tokens: -1,
      },
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.cacheCreation1hTokens).toBeUndefined();
    expect(record?.cacheCreation5mTokens).toBeUndefined();
  });

  it("drops a speed longer than the value Revenium stores instead of truncating it", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 1000,
      speed: "a".repeat(17),
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.speed).toBeUndefined();
  });

  it("keeps a zero bucket distinct from an absent one", () => {
    const line = makeJsonlLine({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 1000,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 1000,
      },
    });

    const { record } = parseJsonlLine(line, null);

    expect(record?.cacheCreation1hTokens).toBe(0);
    expect(record?.cacheCreation5mTokens).toBe(1000);
  });
});

describe("session line to OTLP payload", () => {
  function attributesFor(line: string) {
    const { record } = parseJsonlLine(line, null);
    expect(record).toBeDefined();
    return createOtlpPayload([record!], {}).resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  }

  it("carries fast mode, region and search count off a fast-mode Opus line", () => {
    const attrs = attributesFor(
      makeJsonlLine({
        input_tokens: 1000,
        output_tokens: 500,
        speed: "fast",
        inference_geo: "us",
        server_tool_use: { web_search_requests: 3 },
      }),
    );

    expect(attrs.find((a) => a.key === "speed")?.value.stringValue).toBe("fast");
    expect(attrs.find((a) => a.key === "inference_geo")?.value.stringValue).toBe("us");
    expect(attrs.find((a) => a.key === "web_search_requests")?.value.stringValue).toBe("3");
  });

  it("carries the TTL split off a line shaped like a real transcript", () => {
    const attrs = attributesFor(
      makeJsonlLine({
        input_tokens: 2,
        output_tokens: 272,
        cache_read_input_tokens: 15637,
        cache_creation_input_tokens: 16222,
        cache_creation: { ephemeral_1h_input_tokens: 16222, ephemeral_5m_input_tokens: 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        inference_geo: "not_available",
        speed: "standard",
      }),
    );

    expect(attrs.find((a) => a.key === "cache_creation_tokens")?.value.stringValue).toBe("16222");
    expect(attrs.find((a) => a.key === "cache_creation_1h_tokens")?.value.stringValue).toBe(
      "16222",
    );
    expect(attrs.find((a) => a.key === "cache_creation_5m_tokens")?.value.stringValue).toBe("0");
    expect(attrs.find((a) => a.key === "speed")?.value.stringValue).toBe("standard");
    expect(attrs.some((a) => a.key === "web_search_requests")).toBe(false);
    expect(attrs.some((a) => a.key === "cost_usd")).toBe(false);
  });
});

describe("skill origin of an imported session", () => {
  function makeSkillCallLine(skill: string, caller?: Record<string, unknown>): string {
    return JSON.stringify({
      type: "assistant",
      requestId: "req_123",
      sessionId: "session-abc",
      timestamp: "2024-06-01T12:00:00.000Z",
      message: {
        id: "msg_123",
        model: "claude-3-5-sonnet-20241022",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: "tool_use", name: "Skill", input: { skill }, caller }],
      },
    });
  }

  function activationAttributesFor(line: string) {
    const { record } = parseJsonlLine(line, null);
    const activation = createOtlpPayload([record!], {
      logToolDetails: true,
    }).resourceLogs[0].scopeLogs[0].logRecords.find(
      (r) => r.body.stringValue === "claude_code.skill_activated",
    );
    return activation?.attributes;
  }

  it("marks a model-started plugin skill as proactive and sends no origin", () => {
    const attrs = activationAttributesFor(
      makeSkillCallLine("revenium:rev-ticket-authoring", { type: "direct" }),
    );

    expect(attrs?.find((a) => a.key === "invocation_trigger")?.value.stringValue).toBe(
      "claude-proactive",
    );
    expect(attrs?.some((a) => a.key === "skill.source")).toBe(false);
  });

  it("omits the trigger when the caller is absent", () => {
    const attrs = activationAttributesFor(makeSkillCallLine("review"));

    expect(attrs?.some((a) => a.key === "invocation_trigger")).toBe(false);
    expect(attrs?.find((a) => a.key === "skill.name")?.value.stringValue).toBe("review");
  });

  it("omits the trigger for a caller type it cannot map", () => {
    const attrs = activationAttributesFor(makeSkillCallLine("review", { type: "future-caller" }));

    expect(attrs?.some((a) => a.key === "invocation_trigger")).toBe(false);
  });

  it("omits the trigger for a caller type that names an inherited object key", () => {
    const attrs = activationAttributesFor(makeSkillCallLine("review", { type: "toString" }));

    expect(attrs?.some((a) => a.key === "invocation_trigger")).toBe(false);
  });
});
