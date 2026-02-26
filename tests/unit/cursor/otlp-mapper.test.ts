import { describe, it, expect } from "vitest";
import { buildOtlpPayload } from "../../../src/cursor/core/transform/otlp-mapper.js";
import { createUsageEvent, createCursorConfig } from "../../helpers/fixtures.js";

describe("buildOtlpPayload", () => {
  it("returns valid OTLP structure", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    expect(payload.resourceLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });

  it("sets service.name resource attribute", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe("cursor-ide");
  });

  it("includes organization.name when present", () => {
    const config = createCursorConfig({ organizationName: "Acme" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const orgName = attrs.find((a) => a.key === "organization.name");
    expect(orgName?.value.stringValue).toBe("Acme");
  });

  it("includes product.name when present", () => {
    const config = createCursorConfig({ productName: "Widget" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const prodName = attrs.find((a) => a.key === "product.name");
    expect(prodName?.value.stringValue).toBe("Widget");
  });

  it("includes user.email when present", () => {
    const config = createCursorConfig({ email: "dev@co.com" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const email = attrs.find((a) => a.key === "user.email");
    expect(email?.value.stringValue).toBe("dev@co.com");
  });

  it("computes BigInt nanoseconds for timeUnixNano", () => {
    const event = createUsageEvent({ timestamp: 1700000000000 });
    const payload = buildOtlpPayload([event], createCursorConfig());
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.timeUnixNano).toBe((BigInt(1700000000000) * 1_000_000n).toString());
  });

  it("maps event fields to log attributes", () => {
    const event = createUsageEvent({
      model: "gpt-4",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 10,
        cacheReadTokens: 20,
        totalCents: 500,
      },
    });
    const payload = buildOtlpPayload([event], createCursorConfig());
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

    const getAttr = (key: string) => attrs.find((a) => a.key === key)?.value.stringValue;

    expect(getAttr("model")).toBe("gpt-4");
    expect(getAttr("input_tokens")).toBe("100");
    expect(getAttr("output_tokens")).toBe("50");
    expect(getAttr("cache_read_tokens")).toBe("20");
    expect(getAttr("cache_creation_tokens")).toBe("10");
    expect(getAttr("cost_usd")).toBe("5.000000");
  });

  it("handles multiple events", () => {
    const events = [createUsageEvent(), createUsageEvent({ model: "gpt-3.5" })];
    const payload = buildOtlpPayload(events, createCursorConfig());
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
  });

  it("sets body to cursor_ide.api_response", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toBe("cursor_ide.api_response");
  });
});
