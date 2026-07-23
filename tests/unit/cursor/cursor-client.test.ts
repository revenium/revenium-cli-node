import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchEvents,
  createFetchPacer,
  getCursorMinRequestIntervalMs,
  DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS,
} from "../../../src/cursor/core/cursor-client.js";
import type { CursorPaginatedResponse, CursorUsageEvent } from "../../../src/cursor/types.js";

const apiKey = "cur_secret_key_123";

// Each request arms an AbortController timeout via setTimeout(_, requestTimeoutMs).
// Pin it to a sentinel so tests can distinguish real pacing/backoff sleeps from
// the per-request abort timer when inspecting the setTimeout spy.
const REQUEST_TIMEOUT_SENTINEL = 987_654;

function makeEvent(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    timestamp: 1_700_000_000_000,
    model: "gpt-4",
    kind: "composer",
    userEmail: "dev@example.com",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: 1,
    },
    ...overrides,
  };
}

function makePage(events: CursorUsageEvent[], hasNextPage: boolean): CursorPaginatedResponse {
  return {
    totalUsageEventsCount: events.length,
    pagination: {
      numPages: hasNextPage ? 2 : 1,
      currentPage: 1,
      pageSize: 100,
      hasNextPage,
      hasPreviousPage: false,
    },
    usageEvents: events,
  };
}

function okResponse(data: object, headers?: Record<string, string>) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(headers),
  };
}

function errorResponse(status: number, body = "error", headers?: Record<string, string>) {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
    headers: new Headers(headers),
  };
}

async function drainWithFakeTimers(
  gen: AsyncGenerator<CursorUsageEvent[]>,
): Promise<CursorUsageEvent[][]> {
  const collected: CursorUsageEvent[][] = [];
  const consume = (async () => {
    for await (const batch of gen) {
      collected.push(batch);
    }
  })();
  await vi.runAllTimersAsync();
  await consume;
  return collected;
}

function sleepCalls(spy: ReturnType<typeof vi.spyOn>): number[] {
  return spy.mock.calls
    .map((call) => call[1])
    .filter(
      (ms): ms is number => typeof ms === "number" && ms > 0 && ms !== REQUEST_TIMEOUT_SENTINEL,
    );
}

describe("getCursorMinRequestIntervalMs", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to 7500ms (~8 req/min, well under Cursor's 20 req/min limit)", () => {
    delete process.env.CURSOR_MIN_REQUEST_INTERVAL_MS;
    expect(DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS).toBe(7500);
    expect(getCursorMinRequestIntervalMs()).toBe(7500);
  });

  it("parses a valid override", () => {
    process.env.CURSOR_MIN_REQUEST_INTERVAL_MS = "3000";
    expect(getCursorMinRequestIntervalMs()).toBe(3000);
  });

  it("ignores invalid, zero, and negative values", () => {
    process.env.CURSOR_MIN_REQUEST_INTERVAL_MS = "abc";
    expect(getCursorMinRequestIntervalMs()).toBe(7500);

    process.env.CURSOR_MIN_REQUEST_INTERVAL_MS = "0";
    expect(getCursorMinRequestIntervalMs()).toBe(7500);

    process.env.CURSOR_MIN_REQUEST_INTERVAL_MS = "-100";
    expect(getCursorMinRequestIntervalMs()).toBe(7500);
  });
});

describe("createFetchPacer", () => {
  it("initializes nextAvailableTimeMs to approximately now", () => {
    const before = Date.now();
    const pacer = createFetchPacer(1000);
    const after = Date.now();
    expect(pacer.nextAvailableTimeMs).toBeGreaterThanOrEqual(before);
    expect(pacer.nextAvailableTimeMs).toBeLessThanOrEqual(after);
  });

  it("uses the configured default when no interval is provided", () => {
    const pacer = createFetchPacer();
    expect(pacer.minIntervalMs).toBe(DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS);
  });

  it("respects an explicit interval override", () => {
    expect(createFetchPacer(1234).minIntervalMs).toBe(1234);
  });

  it("respects an explicit 0 (opt-out of pacing)", () => {
    expect(createFetchPacer(0).minIntervalMs).toBe(0);
  });

  it("falls back to default for non-finite/negative overrides", () => {
    expect(createFetchPacer(NaN).minIntervalMs).toBe(DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS);
    expect(createFetchPacer(-5).minIntervalMs).toBe(DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS);
  });
});

describe("fetchEvents pacing", () => {
  beforeEach(() => {
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_SENTINEL);
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.REVENIUM_REQUEST_TIMEOUT_MS;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not sleep before the first request", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okResponse(makePage([makeEvent()], false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 5000 }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepCalls(setTimeoutSpy)).toHaveLength(0);
  });

  it("waits the configured interval between paginated requests", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 5000 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(2);
    const waits = sleepCalls(setTimeoutSpy);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(5000);
  });

  it("does not pace when the interval is 0 (explicit opt-out)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls(setTimeoutSpy)).toHaveLength(0);
  });
});

describe("fetchEvents retry/backoff", () => {
  beforeEach(() => {
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_SENTINEL);
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.REVENIUM_REQUEST_TIMEOUT_MS;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "rate limited"))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
  });

  it("retries on 503 then succeeds", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, "unavailable"))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
  });

  it("honors Retry-After as a floor on the backoff delay", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "rate limited", { "Retry-After": "2" }))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }));

    const waits = sleepCalls(setTimeoutSpy);
    expect(waits.some((ms) => ms >= 2000)).toBe(true);
  });

  it("does not retry a non-retryable 4xx (401)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(errorResponse(401, "unauthorized"));

    let captured: unknown;
    const gen = fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 });
    const consume = (async () => {
      try {
        for await (const _ of gen) {
          void _;
        }
      } catch (err) {
        captured = err;
      }
    })();
    await vi.runAllTimersAsync();
    await consume;

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("Cursor API 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable 4xx even when the body contains 'timeout' or 'network'", async () => {
    // Regression test: a non-retryable 401/403 whose response body happens to
    // contain a substring like "timed out" or "network" must not be
    // misclassified as a retryable network error by the catch block.
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(errorResponse(401, "session timed out due to network policy"));

    let captured: unknown;
    const gen = fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 });
    const consume = (async () => {
      try {
        for await (const _ of gen) {
          void _;
        }
      } catch (err) {
        captured = err;
      }
    })();
    await vi.runAllTimersAsync();
    await consume;

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("Cursor API 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes the API key out of error messages", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(errorResponse(403, `denied for ${apiKey}`));

    let captured: unknown;
    const gen = fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 });
    const consume = (async () => {
      try {
        for await (const _ of gen) {
          void _;
        }
      } catch (err) {
        captured = err;
      }
    })();
    await vi.runAllTimersAsync();
    await consume;

    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).not.toContain(apiKey);
    expect(message).toContain("***");
  });
});
