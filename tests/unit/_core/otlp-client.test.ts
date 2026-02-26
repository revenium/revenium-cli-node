import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendOtlpLogs } from "../../../src/_core/api/otlp-client.js";
import type { OTLPLogsPayload } from "../../../src/_core/types/index.js";

const mockPayload: OTLPLogsPayload = {
  resourceLogs: [
    {
      scopeLogs: [
        {
          scope: { name: "test", version: "1.0.0" },
          logRecords: [
            {
              body: { stringValue: "test" },
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

const apiKey = "hak_tenant_abc123xyz";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(
  data: object = { id: "1", resourceType: "log", processedEvents: 1, created: "now" },
) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "error") {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

describe("sendOtlpLogs", () => {
  it("sends to correct URL", async () => {
    mockFetchOk();
    await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/meter/v2/otlp/v1/logs",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes x-api-key header", async () => {
    mockFetchOk();
    await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers["x-api-key"]).toBe(apiKey);
  });

  it("returns parsed response on success", async () => {
    const expected = { id: "r1", resourceType: "log", processedEvents: 1, created: "2024-01-01" };
    mockFetchOk(expected);
    const result = await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(result).toEqual(expected);
  });

  it("retries on 503 status", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("retry"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("retry"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
        text: () => Promise.resolve("ok"),
      });

    const result = await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.processedEvents).toBe(1);
  });

  it("throws after max retries on persistent 503", async () => {
    mockFetchError(503, "unavailable");
    await expect(sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload)).rejects.toThrow(
      "OTLP request failed: 503",
    );
  });

  it("throws immediately on non-retryable status", async () => {
    mockFetchError(400, "bad request");
    await expect(sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload)).rejects.toThrow(
      "OTLP request failed: 400",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes API key from error messages", async () => {
    mockFetchError(401, `Invalid key: ${apiKey}`);
    try {
      await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    } catch (e: any) {
      expect(e.message).not.toContain(apiKey);
      expect(e.message).toContain("***");
    }
  });
});
