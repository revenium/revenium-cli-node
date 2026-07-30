import { describe, it, expect } from "vitest";
import {
  createOtlpPayload,
  deduplicateRecords,
  resolveBackfillEmail,
  type ParsedRecord,
} from "../../../src/claude-code/commands/backfill.js";

function makeRecord(overrides: Partial<ParsedRecord> = {}): ParsedRecord {
  return {
    sessionId: "session-abc",
    timestamp: "2024-06-01T12:00:00.000Z",
    model: "claude-3-5-sonnet-20241022",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    ...overrides,
  };
}

describe("createOtlpPayload — resource attributes", () => {
  it("includes service.name in resource attributes", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe("claude-code");
  });

  it("stamps revenium.middleware.source=revenium-cli in resource attributes", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const marker = attrs.find((a) => a.key === "revenium.middleware.source");
    expect(marker?.value.stringValue).toBe("revenium-cli");
  });

  it("does NOT include cost_multiplier in resource attributes", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const costAttr = attrs.find((a) => a.key === "cost_multiplier");
    expect(costAttr).toBeUndefined();
  });

  it("includes organization.name in resource attributes when provided", () => {
    const payload = createOtlpPayload([makeRecord()], { organizationName: "Acme Corp" });
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const orgAttr = attrs.find((a) => a.key === "organization.name");
    expect(orgAttr?.value.stringValue).toBe("Acme Corp");
  });

  it("does NOT include organization.name in resource attributes when not provided", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const orgAttr = attrs.find((a) => a.key === "organization.name");
    expect(orgAttr).toBeUndefined();
  });

  it("includes product.name in resource attributes when provided", () => {
    const payload = createOtlpPayload([makeRecord()], { productName: "My Product" });
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const prodAttr = attrs.find((a) => a.key === "product.name");
    expect(prodAttr?.value.stringValue).toBe("My Product");
  });

  it("does NOT include product.name in resource attributes when not provided", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const prodAttr = attrs.find((a) => a.key === "product.name");
    expect(prodAttr).toBeUndefined();
  });
});

describe("createOtlpPayload — log record attributes", () => {
  it("keeps the transaction_id formula tied to the retained row", () => {
    const first = makeRecord({
      requestId: "req_123",
      messageId: "msg_123",
      timestamp: "2024-06-01T12:00:00.000Z",
    });
    const second = makeRecord({
      requestId: "req_123",
      messageId: "msg_123",
      timestamp: "2024-06-01T12:00:03.000Z",
    });

    const firstAttrs = createOtlpPayload([first], {}).resourceLogs[0].scopeLogs[0].logRecords[0]
      .attributes;
    const secondAttrs = createOtlpPayload([second], {}).resourceLogs[0].scopeLogs[0].logRecords[0]
      .attributes;
    const deduped = deduplicateRecords([first, second]).records;
    const dedupedAttrs = createOtlpPayload(deduped, {}).resourceLogs[0].scopeLogs[0].logRecords[0]
      .attributes;

    expect(firstAttrs.find((a) => a.key === "transaction_id")?.value.stringValue).not.toBe(
      secondAttrs.find((a) => a.key === "transaction_id")?.value.stringValue,
    );
    expect(dedupedAttrs.find((a) => a.key === "transaction_id")?.value.stringValue).toBe(
      secondAttrs.find((a) => a.key === "transaction_id")?.value.stringValue,
    );
    expect(dedupedAttrs.find((a) => a.key === "request_id")?.value.stringValue).toBe("req_123");
    expect(dedupedAttrs.find((a) => a.key === "message.id")?.value.stringValue).toBe("msg_123");
  });

  it("includes user.email in log record attributes when provided", () => {
    const payload = createOtlpPayload([makeRecord()], { email: "dev@example.com" });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const emailAttr = logAttrs.find((a) => a.key === "user.email");
    expect(emailAttr?.value.stringValue).toBe("dev@example.com");
  });

  it("does NOT include user.email in log record attributes when not provided", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const emailAttr = logAttrs.find((a) => a.key === "user.email");
    expect(emailAttr).toBeUndefined();
  });

  it("does NOT include organization.name in log record attributes", () => {
    const payload = createOtlpPayload([makeRecord()], { organizationName: "Acme Corp" });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const orgAttr = logAttrs.find((a) => a.key === "organization.name");
    expect(orgAttr).toBeUndefined();
  });

  it("does NOT include product.name in log record attributes", () => {
    const payload = createOtlpPayload([makeRecord()], { productName: "My Product" });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const prodAttr = logAttrs.find((a) => a.key === "product.name");
    expect(prodAttr).toBeUndefined();
  });

  it("includes token counts in log record attributes", () => {
    const record = makeRecord({
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 15,
      cacheCreationTokens: 8,
    });
    const payload = createOtlpPayload([record], {});
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

    expect(logAttrs.find((a) => a.key === "input_tokens")?.value.stringValue).toBe("200");
    expect(logAttrs.find((a) => a.key === "output_tokens")?.value.stringValue).toBe("75");
    expect(logAttrs.find((a) => a.key === "cache_read_tokens")?.value.stringValue).toBe("15");
    expect(logAttrs.find((a) => a.key === "cache_creation_tokens")?.value.stringValue).toBe("8");
  });
});

describe("deduplicateRecords", () => {
  it("keeps the latest Claude Code streaming snapshot for the same request and message", () => {
    const older = makeRecord({
      requestId: "req_123",
      messageId: "msg_123",
      timestamp: "2024-06-01T12:00:00.000Z",
      outputTokens: 10,
    });
    const latest = makeRecord({
      requestId: "req_123",
      messageId: "msg_123",
      timestamp: "2024-06-01T12:00:02.000Z",
      outputTokens: 50,
    });
    const other = makeRecord({
      requestId: "req_456",
      messageId: "msg_456",
      timestamp: "2024-06-01T12:00:01.000Z",
      outputTokens: 25,
    });

    const result = deduplicateRecords([older, other, latest]);

    expect(result.duplicateCount).toBe(1);
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.requestId === "req_123")?.outputTokens).toBe(50);
    expect(result.records.find((r) => r.requestId === "req_456")?.outputTokens).toBe(25);
  });

  it("does not collapse records without requestId", () => {
    const records = [
      makeRecord({ timestamp: "2024-06-01T12:00:00.000Z" }),
      makeRecord({ timestamp: "2024-06-01T12:00:01.000Z" }),
    ];

    const result = deduplicateRecords(records);

    expect(result.duplicateCount).toBe(0);
    expect(result.records).toHaveLength(2);
  });

  it("does not collapse records without messageId", () => {
    const records = [
      makeRecord({
        requestId: "req_123",
        messageId: undefined,
        timestamp: "2024-06-01T12:00:00.000Z",
      }),
      makeRecord({
        requestId: "req_123",
        messageId: undefined,
        timestamp: "2024-06-01T12:00:01.000Z",
      }),
    ];

    const result = deduplicateRecords(records);

    expect(result.duplicateCount).toBe(0);
    expect(result.records).toHaveLength(2);
  });
});

describe("createOtlpPayload — structure", () => {
  it("returns valid OTLP structure with one resourceLog", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    expect(payload.resourceLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });

  it("handles multiple records", () => {
    const records = [makeRecord(), makeRecord({ sessionId: "session-xyz" })];
    const payload = createOtlpPayload(records, {});
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
  });

  it("sets body to claude_code.api_request", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body.stringValue).toBe("claude_code.api_request");
  });

  it("computes timeUnixNano from timestamp", () => {
    const timestamp = "2024-06-01T12:00:00.000Z";
    const expectedMs = new Date(timestamp).getTime();
    const expectedNano = (BigInt(expectedMs) * BigInt(1_000_000)).toString();

    const payload = createOtlpPayload([makeRecord({ timestamp })], {});
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.timeUnixNano).toBe(expectedNano);
  });
});

describe("resolveBackfillEmail — precedence (non-interactive branches)", () => {
  it("uses the --email flag when provided, over the configured email", async () => {
    expect(await resolveBackfillEmail("flag@example.com", "config@example.com")).toBe(
      "flag@example.com",
    );
  });

  it("falls back to the configured email when no flag is given", async () => {
    expect(await resolveBackfillEmail(undefined, "config@example.com")).toBe("config@example.com");
  });

  it("ignores a whitespace --email and falls back to the configured email", async () => {
    expect(await resolveBackfillEmail("   ", "config@example.com")).toBe("config@example.com");
  });

  it("returns undefined (unattributed) when no TTY and no email is available", async () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      expect(await resolveBackfillEmail(undefined, undefined)).toBeUndefined();
    } finally {
      if (orig) Object.defineProperty(process.stdin, "isTTY", orig);
    }
  });

  it("throws when the --email flag is invalid", async () => {
    await expect(resolveBackfillEmail("not-an-email", undefined)).rejects.toThrow(
      /Invalid --email/,
    );
  });
});

describe("createOtlpPayload — skill and tool attributes", () => {
  function getLogAttrs(payload: ReturnType<typeof createOtlpPayload>, index = 0) {
    return payload.resourceLogs[0].scopeLogs[0].logRecords[index].attributes;
  }

  function findAttr(attrs: Array<{ key: string; value: { stringValue: string } }>, key: string) {
    return attrs.find((a) => a.key === key);
  }

  it("emits stop_reason when present", () => {
    const payload = createOtlpPayload([makeRecord({ stopReason: "end_turn" })], {});
    const attrs = getLogAttrs(payload);
    expect(findAttr(attrs, "stop_reason")?.value.stringValue).toBe("end_turn");
  });

  it("does not emit stop_reason when absent", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = getLogAttrs(payload);
    expect(findAttr(attrs, "stop_reason")).toBeUndefined();
  });

  it("emits skill.name on api_request when skillName is set", () => {
    const payload = createOtlpPayload([makeRecord({ skillName: "review" })], {});
    const apiRecords = payload.resourceLogs[0].scopeLogs[0].logRecords.filter(
      (r) => r.body.stringValue === "claude_code.api_request",
    );
    expect(findAttr(apiRecords[0].attributes, "skill.name")?.value.stringValue).toBe("review");
  });

  it("emits claude_code.skill_activated event when skillName is set", () => {
    const payload = createOtlpPayload([makeRecord({ skillName: "commit" })], {});
    const activations = payload.resourceLogs[0].scopeLogs[0].logRecords.filter(
      (r) => r.body.stringValue === "claude_code.skill_activated",
    );
    expect(activations).toHaveLength(1);
    const attrs = activations[0].attributes;
    expect(findAttr(attrs, "skill.name")?.value.stringValue).toBe("commit");
    expect(findAttr(attrs, "invocation_trigger")?.value.stringValue).toBe("user-slash");
    expect(findAttr(attrs, "skill.source")?.value.stringValue).toBe("userSettings");
    expect(findAttr(attrs, "event.sequence")).toBeDefined();
  });

  it("assigns sequential event.sequence to activation and api_request", () => {
    const payload = createOtlpPayload([makeRecord({ skillName: "review" })], {});
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    const activation = records.find((r) => r.body.stringValue === "claude_code.skill_activated")!;
    const apiRequest = records.find((r) => r.body.stringValue === "claude_code.api_request")!;
    const activationSeq = Number(
      findAttr(activation.attributes, "event.sequence")?.value.stringValue,
    );
    const requestSeq = Number(findAttr(apiRequest.attributes, "event.sequence")?.value.stringValue);
    expect(requestSeq).toBe(activationSeq + 1);
  });

  it("does not emit skill_activated when no skillName", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const activations = payload.resourceLogs[0].scopeLogs[0].logRecords.filter(
      (r) => r.body.stringValue === "claude_code.skill_activated",
    );
    expect(activations).toHaveLength(0);
  });

  it("emits tool_count when toolNames present", () => {
    const payload = createOtlpPayload([makeRecord({ toolNames: ["Bash", "Edit", "Read"] })], {});
    const attrs = getLogAttrs(payload);
    expect(findAttr(attrs, "tool_count")?.value.stringValue).toBe("3");
  });

  it("does not emit tool_count when no toolNames", () => {
    const payload = createOtlpPayload([makeRecord()], {});
    const attrs = getLogAttrs(payload);
    expect(findAttr(attrs, "tool_count")).toBeUndefined();
  });
});
