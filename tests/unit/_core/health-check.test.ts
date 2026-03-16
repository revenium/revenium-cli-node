import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("includes email in log attributes when provided via options", () => {
    const payload = createTestPayload("sess-1", "test-service", {
      email: "dev@co.com",
    });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(logAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe("dev@co.com");
  });

  it("includes organization and product in resource attributes when provided", () => {
    const payload = createTestPayload("sess-1", "test-service", {
      organizationName: "Acme",
      productName: "Widget",
    });
    const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
    expect(resourceAttrs.find((a) => a.key === "organization.name")?.value.stringValue).toBe(
      "Acme",
    );
    expect(resourceAttrs.find((a) => a.key === "product.name")?.value.stringValue).toBe("Widget");
  });

  it("does not include organization and product in log attributes", () => {
    const payload = createTestPayload("sess-1", "test-service", {
      organizationName: "Acme",
      productName: "Widget",
    });
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(logAttrs.find((a) => a.key === "organization.name")).toBeUndefined();
    expect(logAttrs.find((a) => a.key === "product.name")).toBeUndefined();
  });

  describe("email fallback from REVENIUM_SUBSCRIBER_EMAIL env", () => {
    let originalEmail: string | undefined;

    beforeEach(() => {
      originalEmail = process.env.REVENIUM_SUBSCRIBER_EMAIL;
    });

    afterEach(() => {
      if (originalEmail === undefined) {
        delete process.env.REVENIUM_SUBSCRIBER_EMAIL;
      } else {
        process.env.REVENIUM_SUBSCRIBER_EMAIL = originalEmail;
      }
    });

    it("uses env email when options.email is not provided", () => {
      process.env.REVENIUM_SUBSCRIBER_EMAIL = "env@example.com";
      const payload = createTestPayload("sess-1", "test-service");
      const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(logAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
        "env@example.com",
      );
    });

    it("options.email takes priority over env email", () => {
      process.env.REVENIUM_SUBSCRIBER_EMAIL = "env@example.com";
      const payload = createTestPayload("sess-1", "test-service", { email: "options@example.com" });
      const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(logAttrs.find((a) => a.key === "user.email")?.value.stringValue).toBe(
        "options@example.com",
      );
    });

    it("does not add user.email log attr when neither options nor env is set", () => {
      delete process.env.REVENIUM_SUBSCRIBER_EMAIL;
      const payload = createTestPayload("sess-1", "test-service");
      const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(logAttrs.find((a) => a.key === "user.email")).toBeUndefined();
    });
  });

  describe("OTEL_RESOURCE_ATTRIBUTES env parsing", () => {
    let originalOtelAttrs: string | undefined;

    beforeEach(() => {
      originalOtelAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
    });

    afterEach(() => {
      if (originalOtelAttrs === undefined) {
        delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      } else {
        process.env.OTEL_RESOURCE_ATTRIBUTES = originalOtelAttrs;
      }
    });

    it("parses key=value pairs from OTEL_RESOURCE_ATTRIBUTES into resource attrs", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=production,region=us-east-1";
      const payload = createTestPayload("sess-1", "test-service");
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      expect(resourceAttrs.find((a) => a.key === "deployment.environment")?.value.stringValue).toBe(
        "production",
      );
      expect(resourceAttrs.find((a) => a.key === "region")?.value.stringValue).toBe("us-east-1");
    });

    it("URL-decodes values from OTEL_RESOURCE_ATTRIBUTES", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "custom.attr=hello%20world%2C%20test";
      const payload = createTestPayload("sess-1", "test-service");
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      expect(resourceAttrs.find((a) => a.key === "custom.attr")?.value.stringValue).toBe(
        "hello world, test",
      );
    });

    it("does not duplicate service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=other-service,extra.key=val";
      const payload = createTestPayload("sess-1", "test-service");
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      const serviceNameAttrs = resourceAttrs.filter((a) => a.key === "service.name");
      expect(serviceNameAttrs).toHaveLength(1);
      expect(serviceNameAttrs[0].value.stringValue).toBe("test-service");
    });

    it("excludes user.email from resource attrs even if present in OTEL_RESOURCE_ATTRIBUTES", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "user.email=env@example.com,other.key=val";
      const payload = createTestPayload("sess-1", "test-service");
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      expect(resourceAttrs.find((a) => a.key === "user.email")).toBeUndefined();
    });

    it("does not duplicate org/product already added via options", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "organization.name=EnvOrg,product.name=EnvProduct";
      const payload = createTestPayload("sess-1", "test-service", {
        organizationName: "OptionsOrg",
        productName: "OptionsProduct",
      });
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      const orgAttrs = resourceAttrs.filter((a) => a.key === "organization.name");
      const productAttrs = resourceAttrs.filter((a) => a.key === "product.name");
      expect(orgAttrs).toHaveLength(1);
      expect(orgAttrs[0].value.stringValue).toBe("OptionsOrg");
      expect(productAttrs).toHaveLength(1);
      expect(productAttrs[0].value.stringValue).toBe("OptionsProduct");
    });

    it("skips pairs without an equals sign", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "valid.key=val,malformed,other.key=ok";
      const payload = createTestPayload("sess-1", "test-service");
      const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
      expect(resourceAttrs.find((a) => a.key === "valid.key")?.value.stringValue).toBe("val");
      expect(resourceAttrs.find((a) => a.key === "other.key")?.value.stringValue).toBe("ok");
      expect(resourceAttrs.find((a) => a.key === "malformed")).toBeUndefined();
    });
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
