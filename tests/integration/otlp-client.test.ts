import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sendOtlpLogs } from "../../src/_core/api/otlp-client.js";
import { createTestPayload, generateTestSessionId } from "../../src/_core/api/health-check.js";
import { createOtlpPayload } from "../../src/claude-code/commands/backfill.js";
import { OTLP_PATH } from "../../src/_core/constants.js";
import { createOtlpCaptureServer, type OtlpCaptureServer } from "../helpers/otlp-capture-server.js";

describe("OTLP client against capture server", () => {
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

  it("sends POST to correct URL path", async () => {
    const payload = createTestPayload(generateTestSessionId(), "claude-code");
    await sendOtlpLogs(server.baseUrl, "test-api-key", payload);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe(`${OTLP_PATH}/v1/logs`);
    expect(server.requests[0].method).toBe("POST");
  });

  it("sends x-api-key header", async () => {
    const payload = createTestPayload(generateTestSessionId(), "claude-code");
    await sendOtlpLogs(server.baseUrl, "my-secret-key", payload);

    expect(server.requests[0].headers["x-api-key"]).toBe("my-secret-key");
  });

  it("sends Content-Type application/json", async () => {
    const payload = createTestPayload(generateTestSessionId(), "claude-code");
    await sendOtlpLogs(server.baseUrl, "test-key", payload);

    expect(server.requests[0].contentType).toBe("application/json");
  });

  it("sends valid JSON body", async () => {
    const payload = createTestPayload(generateTestSessionId(), "claude-code");
    await sendOtlpLogs(server.baseUrl, "test-key", payload);

    const captured = server.requests[0].parsedPayload as Record<string, unknown>;
    expect(captured).toBeDefined();
    expect(captured).toHaveProperty("resourceLogs");
  });

  it("parses OTLPResponse correctly", async () => {
    const payload = createTestPayload(generateTestSessionId(), "claude-code");
    const response = await sendOtlpLogs(server.baseUrl, "test-key", payload);

    expect(response).toHaveProperty("id");
    expect(response).toHaveProperty("resourceType");
    expect(response).toHaveProperty("processedEvents");
    expect(response).toHaveProperty("created");
    expect(response.processedEvents).toBe(1);
  });

  describe("backfill email placement contract with ClaudeCodeMapper", () => {
    it("claude-code backfill places user.email in log record attributes, not resource attributes", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "test-session",
            timestamp: new Date().toISOString(),
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
        { email: "backfill-user@example.com" },
      );

      await sendOtlpLogs(server.baseUrl, "test-key", payload);

      const captured = server.requests[0].parsedPayload as {
        resourceLogs: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue: string } }>;
            }>;
          }>;
        }>;
      };

      const resourceAttrs = captured.resourceLogs[0].resource.attributes;
      const logRecordAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

      const emailInLogRecord = logRecordAttrs.find((a) => a.key === "user.email");
      expect(emailInLogRecord).toBeDefined();
      expect(emailInLogRecord!.value.stringValue).toBe("backfill-user@example.com");

      const emailInResource = resourceAttrs.find((a) => a.key === "user.email");
      expect(emailInResource).toBeUndefined();
    });

    it("claude-code backfill omits user.email when no email provided", async () => {
      const payload = createOtlpPayload(
        [
          {
            sessionId: "test-session-2",
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

      const captured = server.requests[0].parsedPayload as {
        resourceLogs: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue: string } }>;
            }>;
          }>;
        }>;
      };

      const logRecordAttrs = captured.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      const emailInLogRecord = logRecordAttrs.find((a) => a.key === "user.email");
      expect(emailInLogRecord).toBeUndefined();
    });
  });
});
