import { describe, it, expect, afterEach } from "vitest";
import {
  LOG_FIELDS,
  RESOURCE_FIELDS,
  getFieldsForPlatform,
  getRequiredFieldsForPlatform,
  SERVICE_NAMES,
  SCOPE_NAMES,
  LOG_BODY_VALUES,
  type Platform,
} from "../../../src/_core/schema/field-registry.js";
import {
  createOtlpPayload,
  type ParsedRecord,
} from "../../../src/claude-code/commands/backfill.js";
import { buildOtlpPayload } from "../../../src/cursor/core/transform/otlp-mapper.js";
import { createTestPayload } from "../../../src/_core/api/health-check.js";
import { createUsageEvent, createCursorConfig } from "../../helpers/fixtures.js";

const TOKEN_FIELD_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
];

function makeClaudeRecord(): ParsedRecord {
  return {
    sessionId: "session-abc",
    timestamp: "2024-06-01T12:00:00.000Z",
    model: "claude-3-5-sonnet-20241022",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
  };
}

function extractLogAttributes(payload: Record<string, unknown>) {
  const rl = payload.resourceLogs as Array<Record<string, unknown>>;
  const sl = rl[0].scopeLogs as Array<Record<string, unknown>>;
  const lr = sl[0].logRecords as Array<Record<string, unknown>>;
  return lr[0].attributes as Array<{ key: string; value: Record<string, unknown> }>;
}

function extractResourceAttributes(payload: Record<string, unknown>) {
  const rl = payload.resourceLogs as Array<Record<string, unknown>>;
  const resource = rl[0].resource as Record<string, unknown> | undefined;
  return (resource?.attributes ?? []) as Array<{ key: string; value: Record<string, unknown> }>;
}

function extractScopeName(payload: Record<string, unknown>): string {
  const rl = payload.resourceLogs as Array<Record<string, unknown>>;
  const sl = rl[0].scopeLogs as Array<Record<string, unknown>>;
  const scope = sl[0].scope as Record<string, unknown>;
  return scope.name as string;
}

function getValueType(attr: { value: Record<string, unknown> }): string | null {
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (attr.value[key] !== undefined) return key;
  }
  return null;
}

describe("Field Registry consistency", () => {
  it("all log fields have valid structure", () => {
    for (const field of LOG_FIELDS) {
      expect(field.key).toBeTruthy();
      expect(field.scope).toBe("log");
      expect(field.platforms.length).toBeGreaterThan(0);
      expect(["stringValue", "intValue", "doubleValue", "boolValue"]).toContain(field.type);
    }
  });

  it("all resource fields have valid structure", () => {
    for (const field of RESOURCE_FIELDS) {
      expect(field.key).toBeTruthy();
      expect(field.scope).toBe("resource");
      expect(field.platforms.length).toBeGreaterThan(0);
    }
  });

  it("no duplicate keys within same scope", () => {
    const logKeys = LOG_FIELDS.map((f) => f.key);
    expect(new Set(logKeys).size).toBe(logKeys.length);

    const resourceKeys = RESOURCE_FIELDS.map((f) => f.key);
    expect(new Set(resourceKeys).size).toBe(resourceKeys.length);
  });

  it("all platforms have a service.name, scope name, and body value", () => {
    const platforms: Platform[] = ["claude-code", "cursor", "gemini"];
    for (const p of platforms) {
      expect(SERVICE_NAMES[p]).toBeTruthy();
      expect(SCOPE_NAMES[p]).toBeTruthy();
      expect(LOG_BODY_VALUES[p]).toBeTruthy();
    }
  });
});

describe("Claude Code backfill field parity", () => {
  it("token fields use stringValue", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], { email: "dev@co.com" });
    const attrs = extractLogAttributes(payload);

    for (const fieldKey of TOKEN_FIELD_KEYS) {
      const attr = attrs.find((a) => a.key === fieldKey);
      expect(attr, `${fieldKey} should be present`).toBeDefined();
      if (attr) {
        expect(getValueType(attr), `${fieldKey} should use stringValue`).toBe("stringValue");
      }
    }
  });

  it("includes all required log fields for claude-code", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], { email: "dev@co.com" });
    const attrs = extractLogAttributes(payload);
    const presentKeys = attrs.map((a) => a.key);

    const requiredFields = getRequiredFieldsForPlatform("claude-code", "log");
    for (const field of requiredFields) {
      expect(presentKeys, `missing required field: ${field.key}`).toContain(field.key);
    }
  });

  it("includes all required resource fields for claude-code", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], {
      organizationName: "Acme",
      productName: "Widget",
    });
    const attrs = extractResourceAttributes(payload);
    const presentKeys = attrs.map((a) => a.key);

    const requiredFields = getRequiredFieldsForPlatform("claude-code", "resource");
    for (const field of requiredFields) {
      expect(presentKeys, `missing required resource field: ${field.key}`).toContain(field.key);
    }
  });

  it("all log attributes exist in the field registry", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], { email: "dev@co.com" });
    const attrs = extractLogAttributes(payload);
    const registeredKeys = getFieldsForPlatform("claude-code", "log").map((f) => f.key);

    for (const attr of attrs) {
      expect(registeredKeys, `unregistered field: ${attr.key}`).toContain(attr.key);
    }
  });

  it("all log attribute types match the registry", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], { email: "dev@co.com" });
    const attrs = extractLogAttributes(payload);
    const registry = getFieldsForPlatform("claude-code", "log");

    for (const attr of attrs) {
      const def = registry.find((f) => f.key === attr.key);
      if (!def) continue;
      expect(getValueType(attr), `${attr.key} type mismatch`).toBe(def.type);
    }
  });

  it("service.name matches registry", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], {});
    const attrs = extractResourceAttributes(payload);
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe(SERVICE_NAMES["claude-code"]);
  });

  it("scope.name matches registry", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], {});
    expect(extractScopeName(payload)).toBe(SCOPE_NAMES["claude-code"]);
  });

  it("body value matches registry", () => {
    const payload = createOtlpPayload([makeClaudeRecord()], {});
    const body = payload.resourceLogs[0].scopeLogs[0].logRecords[0].body;
    expect(body.stringValue).toBe(LOG_BODY_VALUES["claude-code"]);
  });
});

describe("Cursor OTLP mapper field parity", () => {
  it("token fields use stringValue", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = extractLogAttributes(payload);

    for (const fieldKey of TOKEN_FIELD_KEYS) {
      const attr = attrs.find((a) => a.key === fieldKey);
      expect(attr, `${fieldKey} should be present`).toBeDefined();
      if (attr) {
        expect(getValueType(attr), `${fieldKey} should use stringValue`).toBe("stringValue");
      }
    }
  });

  it("includes all required log fields for cursor", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = extractLogAttributes(payload);
    const presentKeys = attrs.map((a) => a.key);

    const requiredFields = getRequiredFieldsForPlatform("cursor", "log");
    for (const field of requiredFields) {
      expect(presentKeys, `missing required field: ${field.key}`).toContain(field.key);
    }
  });

  it("all log attributes exist in the field registry", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = extractLogAttributes(payload);
    const registeredKeys = getFieldsForPlatform("cursor", "log").map((f) => f.key);

    for (const attr of attrs) {
      expect(registeredKeys, `unregistered field: ${attr.key}`).toContain(attr.key);
    }
  });

  it("all log attribute types match the registry", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = extractLogAttributes(payload);
    const registry = getFieldsForPlatform("cursor", "log");

    for (const attr of attrs) {
      const def = registry.find((f) => f.key === attr.key);
      if (!def) continue;
      expect(getValueType(attr), `${attr.key} type mismatch`).toBe(def.type);
    }
  });

  it("service.name matches registry", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = extractResourceAttributes(payload);
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe(SERVICE_NAMES["cursor"]);
  });

  it("scope.name matches registry", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    expect(extractScopeName(payload)).toBe(SCOPE_NAMES["cursor"]);
  });

  it("body value matches registry", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const body = payload.resourceLogs[0].scopeLogs[0].logRecords[0].body;
    expect(body.stringValue).toBe(LOG_BODY_VALUES["cursor"]);
  });
});

describe("Gemini health-check field parity", () => {
  afterEach(() => {
    delete process.env.REVENIUM_SUBSCRIBER_EMAIL;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  it("token fields use stringValue", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    const attrs = extractLogAttributes(payload);

    for (const fieldKey of TOKEN_FIELD_KEYS) {
      const attr = attrs.find((a) => a.key === fieldKey);
      expect(attr, `${fieldKey} should be present`).toBeDefined();
      if (attr) {
        expect(getValueType(attr), `${fieldKey} should use stringValue`).toBe("stringValue");
      }
    }
  });

  it("includes all required log fields for gemini", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    const attrs = extractLogAttributes(payload);
    const presentKeys = attrs.map((a) => a.key);

    const requiredFields = getRequiredFieldsForPlatform("gemini", "log");
    for (const field of requiredFields) {
      expect(presentKeys, `missing required field: ${field.key}`).toContain(field.key);
    }
  });

  it("all log attribute types match the registry", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    const attrs = extractLogAttributes(payload);
    const registry = getFieldsForPlatform("gemini", "log");

    for (const attr of attrs) {
      const def = registry.find((f) => f.key === attr.key);
      if (!def) continue;
      expect(getValueType(attr), `${attr.key} type mismatch`).toBe(def.type);
    }
  });

  it("service.name matches registry", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    const attrs = extractResourceAttributes(payload);
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe(SERVICE_NAMES["gemini"]);
  });

  it("scope.name matches registry", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    expect(extractScopeName(payload)).toBe(SCOPE_NAMES["gemini"]);
  });

  it("body value matches registry", () => {
    const payload = createTestPayload("test-session", "gemini-cli");
    const body = payload.resourceLogs[0].scopeLogs[0].logRecords[0].body;
    expect(body.stringValue).toBe(LOG_BODY_VALUES["gemini"]);
  });
});

describe("Cross-SDK token field type consistency", () => {
  afterEach(() => {
    delete process.env.REVENIUM_SUBSCRIBER_EMAIL;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  it("all SDKs encode token fields with the same OTLP type", () => {
    const claudePayload = createOtlpPayload([makeClaudeRecord()], {});
    const cursorPayload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const geminiPayload = createTestPayload("test-session", "gemini-cli");

    const claudeAttrs = extractLogAttributes(claudePayload);
    const cursorAttrs = extractLogAttributes(cursorPayload);
    const geminiAttrs = extractLogAttributes(geminiPayload);

    for (const fieldKey of TOKEN_FIELD_KEYS) {
      const claudeAttr = claudeAttrs.find((a) => a.key === fieldKey);
      const cursorAttr = cursorAttrs.find((a) => a.key === fieldKey);
      const geminiAttr = geminiAttrs.find((a) => a.key === fieldKey);

      expect(claudeAttr, `${fieldKey} missing in claude-code`).toBeDefined();
      expect(cursorAttr, `${fieldKey} missing in cursor`).toBeDefined();
      expect(geminiAttr, `${fieldKey} missing in gemini`).toBeDefined();

      if (claudeAttr && cursorAttr && geminiAttr) {
        const claudeType = getValueType(claudeAttr);
        const cursorType = getValueType(cursorAttr);
        const geminiType = getValueType(geminiAttr);

        expect(claudeType, `${fieldKey}: claude-code vs cursor type mismatch`).toBe(cursorType);
        expect(cursorType, `${fieldKey}: cursor vs gemini type mismatch`).toBe(geminiType);
        expect(claudeType, `${fieldKey}: should be stringValue per registry`).toBe("stringValue");
      }
    }
  });
});
