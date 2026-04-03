import { describe, it, expect } from "vitest";
import {
  createProviderTestPayload,
  REQUIRED_LOG_ATTRIBUTE_KEYS,
  PROVIDER_SERVICE_NAMES,
  PROVIDER_BODY_PATTERNS,
  CURSOR_SPECIFIC_ATTRIBUTE_KEYS,
  type ProviderName,
} from "../../helpers/otlp-fixtures.js";
import {
  validateOtlpPayloadStructure,
  validateLogRecordAttributes,
  validateResourceAttributes,
} from "../../helpers/otlp-validator.js";

function getFirstLogRecord(provider: ProviderName) {
  const payload = createProviderTestPayload(provider);
  return {
    payload,
    resourceLog: payload.resourceLogs[0],
    scopeLog: payload.resourceLogs[0].scopeLogs[0],
    logRecord: payload.resourceLogs[0].scopeLogs[0].logRecords[0],
  };
}

describe("OTLP payload schema - claude-code", () => {
  const provider: ProviderName = "claude-code";

  it("has valid structure", () => {
    const payload = createProviderTestPayload(provider);
    const result = validateOtlpPayloadStructure(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has all required log attributes", () => {
    const { logRecord } = getFirstLogRecord(provider);
    const result = validateLogRecordAttributes(logRecord.attributes, REQUIRED_LOG_ATTRIBUTE_KEYS);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct resource attributes", () => {
    const { resourceLog } = getFirstLogRecord(provider);
    const result = validateResourceAttributes(
      resourceLog.resource!.attributes!,
      PROVIDER_SERVICE_NAMES[provider],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct body pattern", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(logRecord.body.stringValue).toBe(PROVIDER_BODY_PATTERNS[provider]);
  });

  it("has scope with name and version", () => {
    const { scopeLog } = getFirstLogRecord(provider);
    expect(scopeLog.scope).toBeDefined();
    expect(scopeLog.scope!.name).toBe(PROVIDER_SERVICE_NAMES[provider]);
    expect(scopeLog.scope!.version).toBeDefined();
  });

  it("has timeUnixNano as string", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(typeof logRecord.timeUnixNano).toBe("string");
    expect(Number(logRecord.timeUnixNano)).toBeGreaterThan(0);
  });
});

describe("OTLP payload schema - gemini-cli", () => {
  const provider: ProviderName = "gemini-cli";

  it("has valid structure", () => {
    const payload = createProviderTestPayload(provider);
    const result = validateOtlpPayloadStructure(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has all required log attributes", () => {
    const { logRecord } = getFirstLogRecord(provider);
    const result = validateLogRecordAttributes(logRecord.attributes, REQUIRED_LOG_ATTRIBUTE_KEYS);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct resource attributes", () => {
    const { resourceLog } = getFirstLogRecord(provider);
    const result = validateResourceAttributes(
      resourceLog.resource!.attributes!,
      PROVIDER_SERVICE_NAMES[provider],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct body pattern", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(logRecord.body.stringValue).toBe(PROVIDER_BODY_PATTERNS[provider]);
  });

  it("has scope with name and version", () => {
    const { scopeLog } = getFirstLogRecord(provider);
    expect(scopeLog.scope).toBeDefined();
    expect(scopeLog.scope!.name).toBe(PROVIDER_SERVICE_NAMES[provider]);
    expect(scopeLog.scope!.version).toBeDefined();
  });

  it("has timeUnixNano as string", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(typeof logRecord.timeUnixNano).toBe("string");
    expect(Number(logRecord.timeUnixNano)).toBeGreaterThan(0);
  });
});

describe("OTLP payload schema - cursor-ide", () => {
  const provider: ProviderName = "cursor";

  it("has valid structure", () => {
    const payload = createProviderTestPayload(provider);
    const result = validateOtlpPayloadStructure(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct resource attributes", () => {
    const { resourceLog } = getFirstLogRecord(provider);
    const result = validateResourceAttributes(
      resourceLog.resource!.attributes!,
      PROVIDER_SERVICE_NAMES[provider],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has correct body pattern", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(logRecord.body.stringValue).toBe(PROVIDER_BODY_PATTERNS[provider]);
  });

  it("has cursor-specific attributes", () => {
    const { logRecord } = getFirstLogRecord(provider);
    const result = validateLogRecordAttributes(
      logRecord.attributes,
      CURSOR_SPECIFIC_ATTRIBUTE_KEYS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("has scope name cursor_admin_api", () => {
    const { scopeLog } = getFirstLogRecord(provider);
    expect(scopeLog.scope).toBeDefined();
    expect(scopeLog.scope!.name).toBe("cursor_admin_api");
  });

  it("has timeUnixNano as string", () => {
    const { logRecord } = getFirstLogRecord(provider);
    expect(typeof logRecord.timeUnixNano).toBe("string");
    expect(Number(logRecord.timeUnixNano)).toBeGreaterThan(0);
  });
});

describe("OTLP payload schema - cross-provider", () => {
  const providers: ProviderName[] = ["claude-code", "gemini-cli", "cursor"];

  it("all providers share same nesting depth", () => {
    for (const provider of providers) {
      const payload = createProviderTestPayload(provider);
      expect(payload.resourceLogs).toHaveLength(1);
      expect(payload.resourceLogs[0].scopeLogs).toHaveLength(1);
      expect(payload.resourceLogs[0].scopeLogs[0].logRecords.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("all providers use stringValue for attributes", () => {
    for (const provider of providers) {
      const { logRecord } = getFirstLogRecord(provider);
      for (const attr of logRecord.attributes) {
        expect(attr.value).toHaveProperty("stringValue");
        expect(typeof attr.value.stringValue).toBe("string");
      }
    }
  });
});
