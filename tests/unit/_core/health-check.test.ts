import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkEndpointHealth,
  createTestPayload,
  generateTestSessionId,
} from "../../../src/_core/api/health-check.js";

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn(),
}));

import { sendOtlpLogs } from "../../../src/_core/api/otlp-client.js";

const mockedSendOtlpLogs = sendOtlpLogs as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateTestSessionId", () => {
  it("starts with test- prefix", () => {
    const id = generateTestSessionId();
    expect(id).toMatch(/^test-/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, generateTestSessionId));
    expect(ids.size).toBe(100);
  });
});

describe("createTestPayload", () => {
  it("creates valid OTLP structure", () => {
    const payload = createTestPayload("sess-1", "test-service");
    expect(payload.resourceLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });

  it("sets service.name resource attribute", () => {
    const payload = createTestPayload("sess-1", "test-service");
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    expect(attrs.find((a) => a.key === "service.name")?.value.stringValue).toBe("test-service");
  });

  it("includes email when provided", () => {
    const payload = createTestPayload("sess-1", "test-service", {
      email: "dev@co.com",
    });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(logAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe("dev@co.com");
  });

  it("includes organization and product when provided", () => {
    const payload = createTestPayload("sess-1", "test-service", {
      organizationName: "Acme",
      productName: "Widget",
    });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(logAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe("Acme");
    expect(logAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe("Widget");
  });
});

describe("checkEndpointHealth", () => {
  it("returns healthy on success", async () => {
    mockedSendOtlpLogs.mockResolvedValue({
      id: "1",
      resourceType: "log",
      processedEvents: 1,
      created: "now",
    });

    const result = await checkEndpointHealth(
      "https://api.revenium.ai",
      "hak_test_key123",
      "test-service",
    );

    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toContain("healthy");
  });

  it("returns unhealthy on failure", async () => {
    mockedSendOtlpLogs.mockRejectedValue(
      new Error("OTLP request failed: 401 Unauthorized - Invalid key"),
    );

    const result = await checkEndpointHealth(
      "https://api.revenium.ai",
      "hak_bad_key",
      "test-service",
    );

    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.message).toContain("401");
  });

  it("reports latency", async () => {
    mockedSendOtlpLogs.mockResolvedValue({
      id: "1",
      resourceType: "log",
      processedEvents: 1,
      created: "now",
    });

    const result = await checkEndpointHealth(
      "https://api.revenium.ai",
      "hak_test_key123",
      "test-service",
    );
    expect(typeof result.latencyMs).toBe("number");
  });
});
