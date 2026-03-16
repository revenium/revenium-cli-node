import { describe, it, expect } from "vitest";
import {
  createOtlpPayload,
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

    expect(logAttrs.find((a) => a.key === "input_tokens")?.value.intValue).toBe(200);
    expect(logAttrs.find((a) => a.key === "output_tokens")?.value.intValue).toBe(75);
    expect(logAttrs.find((a) => a.key === "cache_read_tokens")?.value.intValue).toBe(15);
    expect(logAttrs.find((a) => a.key === "cache_creation_tokens")?.value.intValue).toBe(8);
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
