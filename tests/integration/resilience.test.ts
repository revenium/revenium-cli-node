import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { sendOtlpLogs } from "../../src/_core/api/otlp-client.js";
import { startupStagger } from "../../src/_core/api/resilience.js";
import { MIN_REQUEST_INTERVAL_MS } from "../../src/_core/api/rate-limiter.js";
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

function createResetThenSucceedServer(resetCount: number) {
  let connectionCount = 0;
  let server: NetServer;
  let port = 0;

  const successBody = JSON.stringify({
    id: "reset-then-succeed",
    resourceType: "logs",
    processedEvents: 1,
    created: "2026-10-19T00:00:00.000Z",
  });

  function handler(socket: Socket) {
    connectionCount++;

    if (connectionCount <= resetCount) {
      socket.destroy();
      return;
    }

    socket.on("data", () => {
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(successBody)}\r\nConnection: close\r\n\r\n${successBody}`,
      );
    });
  }

  return {
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    get connectionCount() {
      return connectionCount;
    },
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createNetServer(handler);
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

async function findClosedPortUrl(): Promise<string> {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      resolve(addr && typeof addr === "object" ? addr.port : 0);
    });
    probe.on("error", reject);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
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

    it("retries on 503 and succeeds on third attempt, never twice within a second", async () => {
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");
      const result = await sendOtlpLogs(server.baseUrl, "test-key", payload);

      expect(result).toHaveProperty("id");
      expect(server.requestCount).toBe(3);

      const [t0, t1, t2] = server.requestTimestamps;
      const delay1 = t1 - t0;
      const delay2 = t2 - t1;

      const schedulingSlackMs = 100;
      const floor = MIN_REQUEST_INTERVAL_MS - schedulingSlackMs;

      expect(delay1).toBeGreaterThanOrEqual(floor);
      expect(delay1).toBeLessThan(MIN_REQUEST_INTERVAL_MS + 1000);

      expect(delay2).toBeGreaterThanOrEqual(floor);
      expect(delay2).toBeLessThan(MIN_REQUEST_INTERVAL_MS + 1000);
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

  describe("connection-level failure retry", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries a reset connection and succeeds on the third attempt", async () => {
      const server = createResetThenSucceedServer(2);
      await server.start();

      try {
        const payload = createTestPayload(generateTestSessionId(), "test-resilience");
        const result = await sendOtlpLogs(server.baseUrl, "test-key", payload);

        expect(result).toHaveProperty("id");
        expect(server.connectionCount).toBe(3);
      } finally {
        await server.stop();
      }
    });

    it("exhausts the retry budget on a refused connection and reports the cause", async () => {
      process.env.REVENIUM_MAX_RETRIES = "2";
      process.env.REVENIUM_BACKOFF_BASE_MS = "400";
      vi.spyOn(Math, "random").mockReturnValue(1);

      const url = await findClosedPortUrl();
      const payload = createTestPayload(generateTestSessionId(), "test-resilience");
      const start = Date.now();

      await expect(sendOtlpLogs(url, "test-key", payload)).rejects.toThrow("ECONNREFUSED");
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });

    it("stops at the configured attempt count when the connection keeps resetting", async () => {
      process.env.REVENIUM_MAX_RETRIES = "2";
      const server = createResetThenSucceedServer(999);
      await server.start();

      try {
        const payload = createTestPayload(generateTestSessionId(), "test-resilience");
        await expect(sendOtlpLogs(server.baseUrl, "test-key", payload)).rejects.toThrow();
        expect(server.connectionCount).toBe(2);
      } finally {
        await server.stop();
      }
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
