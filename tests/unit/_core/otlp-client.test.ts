import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/_core/api/rate-limiter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(undefined),
    createRateLimiterState: actual.createRateLimiterState,
  };
});

import { sendOtlpLogs, sendOtlpTraces } from "../../../src/_core/api/otlp-client.js";
import { enforceRateLimit } from "../../../src/_core/api/rate-limiter.js";
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
    headers: new Headers(),
  });
}

function mockFetchError(status: number, body = "error", headers?: Record<string, string>) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
    headers: new Headers(headers),
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
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("retry"),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
        text: () => Promise.resolve("ok"),
        headers: new Headers(),
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

  it("throws immediately on non-retryable 4xx", async () => {
    mockFetchError(400, "bad request");
    await expect(sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload)).rejects.toThrow(
      "OTLP request failed: 400",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 401", async () => {
    mockFetchError(401, "unauthorized");
    await expect(sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload)).rejects.toThrow(
      "OTLP request failed: 401",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 403", async () => {
    mockFetchError(403, "forbidden");
    await expect(sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload)).rejects.toThrow(
      "OTLP request failed: 403",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("rate limited"),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
        headers: new Headers(),
      });

    const result = await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.processedEvents).toBe(1);
  });

  it("retries on 408", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 408,
        statusText: "Request Timeout",
        text: () => Promise.resolve("timeout"),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
        headers: new Headers(),
      });

    const result = await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.processedEvents).toBe(1);
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

  describe("Retry-After header", () => {
    it("parses Retry-After as integer seconds", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      const startTime = Date.now();
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: () => Promise.resolve("rate limited"),
          headers: new Headers({ "Retry-After": "1" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
          headers: new Headers(),
        });

      await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it("uses Retry-After as floor, never reduces with jitter", async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      const startTime = Date.now();
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: () => Promise.resolve("rate limited"),
          headers: new Headers({ "Retry-After": "2" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ id: "1", resourceType: "log", processedEvents: 1, created: "now" }),
          headers: new Headers(),
        });

      await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(1900);
    });
  });
});

describe("global rate limiting", () => {
  const enforceRateLimitMock = enforceRateLimit as ReturnType<typeof vi.fn>;

  afterEach(() => {
    enforceRateLimitMock.mockClear();
  });

  it("enforces rate limit on sendOtlpLogs with default batchSize", async () => {
    mockFetchOk();
    await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ nextAvailableTimeMs: expect.any(Number) }),
      expect.objectContaining({ batchSize: 1 }),
    );
  });

  it("forwards batchSize option to rate limiter", async () => {
    mockFetchOk();
    await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload, { batchSize: 50 });
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ batchSize: 50 }),
    );
  });

  it("forwards userDelayMs option to rate limiter", async () => {
    mockFetchOk();
    await sendOtlpLogs("https://api.revenium.ai", apiKey, mockPayload, {
      batchSize: 10,
      userDelayMs: 500,
    });
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ batchSize: 10, userDelayMs: 500 }),
    );
  });

  it("enforces rate limit on sendOtlpTraces", async () => {
    mockFetchOk();
    await sendOtlpTraces("https://api.revenium.ai", apiKey, mockPayload as any, {
      batchSize: 25,
    });
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ batchSize: 25 }),
    );
  });
});
