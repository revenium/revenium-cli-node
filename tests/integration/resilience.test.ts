import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { sendOtlpLogs } from "../../src/_core/api/otlp-client.js";
import { startupStagger } from "../../src/_core/api/resilience.js";
import { createTestPayload, generateTestSessionId } from "../../src/_core/api/health-check.js";

function createFailThenSucceedServer(
  failCount: number,
  failStatus: number,
  retryAfterSeconds?: number,
) {
  let requestTimestamps: number[] = [];
  let requestCount = 0;
  let server: Server;
  let port = 0;

  function handler(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requestTimestamps.push(Date.now());
      requestCount++;

      if (requestCount <= failCount) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (retryAfterSeconds !== undefined && failStatus === 429) {
          headers["Retry-After"] = String(retryAfterSeconds);
        }
        res.writeHead(failStatus, headers);
        res.end(JSON.stringify({ error: "Service unavailable" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `test-${Date.now()}`,
          resourceType: "logs",
          processedEvents: 1,
          created: new Date().toISOString(),
        }),
      );
    });
  }

  return {
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    get requestTimestamps() {
      return requestTimestamps;
    },
    get requestCount() {
      return requestCount;
    },
    reset() {
      requestTimestamps = [];
      requestCount = 0;
    },
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") port = addr.port;
          resolve();
        });
        server.on("error", reject);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    },
  };
}

describe("resilience integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.REVENIUM_BACKOFF_BASE_MS = "200";
    process.env.REVENIUM_MAX_RETRIES = "3";
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = "5000";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("otlp-client retry with jitter against real server", () => {
    let server: ReturnType<typeof createFailThenSucceedServer>;

    beforeAll(async () => {
      server = createFailThenSucceedServer(2, 503);
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    beforeEach(() => {
      server.reset();
    });

    it("retries on 503 and succeeds on third attempt with jittered delays", async () => {
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");
      const result = await sendOtlpLogs(server.baseUrl, "test-key", payload);

      expect(result).toHaveProperty("id");
      expect(server.requestCount).toBe(3);

      const [t0, t1, t2] = server.requestTimestamps;
      const delay1 = t1 - t0;
      const delay2 = t2 - t1;

      expect(delay1).toBeGreaterThanOrEqual(0);
      expect(delay1).toBeLessThan(800);

      expect(delay2).toBeGreaterThanOrEqual(0);
      expect(delay2).toBeLessThan(1200);
    });
  });

  describe("retry-after header obedience", () => {
    let server: ReturnType<typeof createFailThenSucceedServer>;

    beforeAll(async () => {
      server = createFailThenSucceedServer(1, 429, 1);
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    beforeEach(() => {
      server.reset();
    });

    it("waits at least Retry-After seconds before retrying a 429", async () => {
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");
      const result = await sendOtlpLogs(server.baseUrl, "test-key", payload);

      expect(result).toHaveProperty("id");
      expect(server.requestCount).toBe(2);

      const [t0, t1] = server.requestTimestamps;
      const delay = t1 - t0;

      expect(delay).toBeGreaterThanOrEqual(950);
    });
  });

  describe("non-retryable 4xx fail-fast", () => {
    let server: ReturnType<typeof createFailThenSucceedServer>;

    beforeAll(async () => {
      server = createFailThenSucceedServer(999, 400);
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    beforeEach(() => {
      server.reset();
    });

    it("does not retry on 400", async () => {
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");

      await expect(sendOtlpLogs(server.baseUrl, "test-key", payload)).rejects.toThrow("400");
      expect(server.requestCount).toBe(1);
    });

    it("does not retry on 401", async () => {
      server.reset();
      server.stop();

      const s401 = createFailThenSucceedServer(999, 401);
      await s401.start();

      const payload = createTestPayload(generateTestSessionId(), "test-resilience");
      await expect(sendOtlpLogs(s401.baseUrl, "test-key", payload)).rejects.toThrow("401");
      expect(s401.requestCount).toBe(1);

      await s401.stop();
    });
  });

  describe("startup stagger", () => {
    it("delays execution by random amount within range", async () => {
      process.env.REVENIUM_STARTUP_STAGGER_MS = "500";
      const start = Date.now();
      await startupStagger();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(600);
    });

    it("skips delay when set to zero", async () => {
      process.env.REVENIUM_STARTUP_STAGGER_MS = "0";
      const start = Date.now();
      await startupStagger();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("configurable max retries", () => {
    let server: ReturnType<typeof createFailThenSucceedServer>;

    beforeAll(async () => {
      server = createFailThenSucceedServer(999, 503);
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    beforeEach(() => {
      server.reset();
    });

    it("respects REVENIUM_MAX_RETRIES=1 (single attempt, no retry)", async () => {
      process.env.REVENIUM_MAX_RETRIES = "1";
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");

      await expect(sendOtlpLogs(server.baseUrl, "test-key", payload)).rejects.toThrow("503");
      expect(server.requestCount).toBe(1);
    });

    it("respects REVENIUM_MAX_RETRIES=2 (two attempts total)", async () => {
      process.env.REVENIUM_MAX_RETRIES = "2";
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");

      await expect(sendOtlpLogs(server.baseUrl, "test-key", payload)).rejects.toThrow("503");
      expect(server.requestCount).toBe(2);
    });
  });
});
