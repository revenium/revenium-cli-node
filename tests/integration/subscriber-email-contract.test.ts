import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sendOtlpLogs } from "../../src/_core/api/otlp-client.js";
import { createOtlpPayload } from "../../src/claude-code/commands/backfill.js";
import { generateEnvContent as generateClaudeEnvContent } from "../../src/claude-code/config/writer.js";
import { generateEnvContent as generateCodexEnvContent } from "../../src/codex-cli/config/writer.js";
import { createOtlpCaptureServer, type OtlpCaptureServer } from "../helpers/otlp-capture-server.js";

interface OtlpPayload {
  resourceLogs: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeLogs: Array<{
      logRecords: Array<{
        attributes: Array<{ key: string; value: unknown }>;
      }>;
    }>;
  }>;
}

function findAttr(
  attrs: Array<{ key: string; value: unknown }>,
  key: string,
): { key: string; value: unknown } | undefined {
  return attrs.find((a) => a.key === key);
}

function getStringValue(attr: { value: unknown }): string {
  return (attr.value as { stringValue: string }).stringValue;
}

describe("subscriber email contract (SE-137 / SE-138)", () => {
  let server: OtlpCaptureServer;

  beforeAll(async () => {
    server = createOtlpCaptureServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Claude Code backfill — email in log record attributes (SE-137)", () => {
    it("places user.email in log record attributes when email is provided", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "s1",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
        { email: "user@company.com" },
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);
      const captured = server.requests[0].parsedPayload as OtlpPayload;
      const logAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      const resourceAttrs = captured.resourceLogs[0].resource.attributes;

      const emailInLog = findAttr(logAttrs, "user.email");
      expect(emailInLog).toBeDefined();
      expect(getStringValue(emailInLog!)).toBe("user@company.com");
      expect(findAttr(resourceAttrs, "user.email")).toBeUndefined();
    });

    it("omits user.email entirely when no email provided", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "s2",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
        {},
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);
      const captured = server.requests[0].parsedPayload as OtlpPayload;
      const logAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      const resourceAttrs = captured.resourceLogs[0].resource.attributes;

      expect(findAttr(logAttrs, "user.email")).toBeUndefined();
      expect(findAttr(resourceAttrs, "user.email")).toBeUndefined();
    });

    it("places email on every log record in a multi-record batch", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "s3a",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 50,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          {
            sessionId: "s3b",
            timestamp: new Date().toISOString(),
            model: "claude-opus-4",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
          },
        ],
        { email: "batch@company.com" },
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);
      const captured = server.requests[0].parsedPayload as OtlpPayload;
      const logRecords = captured.resourceLogs[0].scopeLogs[0].logRecords;

      expect(logRecords).toHaveLength(2);
      for (const record of logRecords) {
        const email = findAttr(record.attributes, "user.email");
        expect(email).toBeDefined();
        expect(getStringValue(email!)).toBe("batch@company.com");
      }
    });

    it("does NOT put email in resource attributes even with org and product", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "s4",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
        {
          email: "org-user@company.com",
          organizationName: "Acme Corp",
          productName: "My Product",
        },
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);
      const captured = server.requests[0].parsedPayload as OtlpPayload;
      const resourceAttrs = captured.resourceLogs[0].resource.attributes;
      const logAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

      expect(findAttr(resourceAttrs, "user.email")).toBeUndefined();
      expect(findAttr(logAttrs, "user.email")).toBeDefined();
      expect(getStringValue(findAttr(logAttrs, "user.email")!)).toBe("org-user@company.com");

      expect(findAttr(resourceAttrs, "organization.name")).toBeDefined();
      expect(findAttr(resourceAttrs, "product.name")).toBeDefined();
    });
  });

  describe("live mode config writers — email only in OTEL_RESOURCE_ATTRIBUTES (intentional)", () => {
    it("claude-code: email in OTEL_RESOURCE_ATTRIBUTES and REVENIUM_SUBSCRIBER_EMAIL", () => {
      const envContent = generateClaudeEnvContent({
        endpoint: "https://api.revenium.ai",
        apiKey: "hak_test",
        email: "live-user@company.com",
      });

      expect(envContent).toContain("REVENIUM_SUBSCRIBER_EMAIL");
      expect(envContent).toContain("live-user@company.com");

      const otelLine = envContent.split("\n").find((l) => l.includes("OTEL_RESOURCE_ATTRIBUTES"));
      expect(otelLine).toBeDefined();
      expect(otelLine).toContain("user.email=live-user@company.com");
    });

    it("claude-code: no email fields when email not configured", () => {
      const envContent = generateClaudeEnvContent({
        endpoint: "https://api.revenium.ai",
        apiKey: "hak_test",
      });

      expect(envContent).not.toContain("REVENIUM_SUBSCRIBER_EMAIL");
      const otelLine = envContent.split("\n").find((l) => l.includes("OTEL_RESOURCE_ATTRIBUTES"));
      expect(otelLine).not.toContain("user.email");
    });

    it("codex-cli: email in OTEL_RESOURCE_ATTRIBUTES and REVENIUM_SUBSCRIBER_EMAIL", () => {
      const envContent = generateCodexEnvContent({
        apiKey: "hak_test",
        email: "codex-live@company.com",
      });

      expect(envContent).toContain("REVENIUM_SUBSCRIBER_EMAIL");
      expect(envContent).toContain("codex-live@company.com");

      const otelLine = envContent.split("\n").find((l) => l.includes("OTEL_RESOURCE_ATTRIBUTES"));
      expect(otelLine).toBeDefined();
      expect(otelLine).toContain("user.email=codex-live@company.com");
    });

    it("codex-cli: no email fields when email not configured", () => {
      const envContent = generateCodexEnvContent({
        apiKey: "hak_test",
      });

      expect(envContent).not.toContain("REVENIUM_SUBSCRIBER_EMAIL");
      expect(envContent).not.toContain("user.email");
    });
  });

  describe("backend mapper contract verification", () => {
    it("backfill payload has service.name=claude-code and email in log record attrs", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "contract-test",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
        { email: "contract@test.com" },
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);
      const captured = server.requests[0].parsedPayload as OtlpPayload;
      const logAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      const resourceAttrs = captured.resourceLogs[0].resource.attributes;

      expect(getStringValue(findAttr(resourceAttrs, "service.name")!)).toBe("claude-code");

      const email = findAttr(logAttrs, "user.email");
      expect(email).toBeDefined();
      expect(getStringValue(email!)).toBe("contract@test.com");

      expect(findAttr(resourceAttrs, "user.email")).toBeUndefined();
    });

    it("live mode writer: email goes to resource level where mapper intentionally ignores it", () => {
      const envContent = generateClaudeEnvContent({
        endpoint: "https://api.revenium.ai",
        apiKey: "hak_test",
        email: "resource-only@test.com",
      });

      const otelLine = envContent.split("\n").find((l) => l.includes("OTEL_RESOURCE_ATTRIBUTES"));
      expect(otelLine).toContain("user.email=resource-only@test.com");
    });
  });
});
