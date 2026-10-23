import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchEvents,
  testConnectivity,
  createFetchPacer,
  getCursorMinRequestIntervalMs,
  getCursorPageSize,
  DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS,
  CURSOR_MAX_PAGE_SIZE,
  CursorWindowTruncatedError,
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

function makePage(
  events: CursorUsageEvent[],
  hasNextPage: boolean,
  pageSize: number = CURSOR_MAX_PAGE_SIZE,
): CursorPaginatedResponse {
  return {
    totalUsageEventsCount: events.length,
    pagination: {
      numPages: hasNextPage ? 2 : 1,
      currentPage: 1,
      pageSize,
      hasNextPage,
      hasPreviousPage: false,
    },
    usageEvents: events,
  };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<string, unknown>;
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

async function settleWithFakeTimers(
  gen: AsyncGenerator<CursorUsageEvent[]>,
): Promise<{ batches: CursorUsageEvent[][]; error: unknown }> {
  const batches: CursorUsageEvent[][] = [];
  let error: unknown;
  const consume = (async () => {
    try {
      for await (const batch of gen) {
        batches.push(batch);
      }
    } catch (err) {
      error = err;
    }
  })();
  await vi.runAllTimersAsync();
  await consume;
  return { batches, error };
}

async function drainWithFakeTimers(
  gen: AsyncGenerator<CursorUsageEvent[]>,
): Promise<CursorUsageEvent[][]> {
  const { batches, error } = await settleWithFakeTimers(gen);
  if (error) throw error;
  return batches;
}

async function drainCapturingError(gen: AsyncGenerator<CursorUsageEvent[]>): Promise<unknown> {
  const { error } = await settleWithFakeTimers(gen);
  return error;
}

function transportFailure(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: { code } });
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

describe("getCursorPageSize", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to Cursor's documented maximum", () => {
    delete process.env.CURSOR_PAGE_SIZE;
    expect(CURSOR_MAX_PAGE_SIZE).toBe(1000);
    expect(getCursorPageSize()).toBe(1000);
  });

  it("falls back to the maximum for invalid, zero, and negative values", () => {
    for (const value of ["abc", "0", "-100", "1e4", "1,000", "1_000", "2k", "500abc"]) {
      process.env.CURSOR_PAGE_SIZE = value;
      expect(getCursorPageSize()).toBe(1000);
    }
  });

  it("warns when the value is rejected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CURSOR_PAGE_SIZE = "1e4";

    getCursorPageSize();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CURSOR_PAGE_SIZE"));
    warn.mockRestore();
  });
});

describe("cursor request page size", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_SENTINEL);
    delete process.env.CURSOR_PAGE_SIZE;
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function requestedPageSize(): Promise<unknown> {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okResponse(makePage([makeEvent()], false)));
    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }));
    return requestBody(fetchMock, 0).pageSize;
  }

  it("requests Cursor's maximum page size by default", async () => {
    expect(await requestedPageSize()).toBe(1000);
  });

  it("reads 1000 events in a single Cursor request", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const events = Array.from({ length: 1000 }, () => makeEvent());
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const { page, pageSize } = JSON.parse(init.body) as { page: number; pageSize: number };
      const read = page * pageSize;
      return Promise.resolve(
        okResponse(makePage(events.slice(read - pageSize, read), read < events.length, pageSize)),
      );
    });

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches.flat()).toHaveLength(1000);
  });

  it("honours a CURSOR_PAGE_SIZE below the ceiling", async () => {
    process.env.CURSOR_PAGE_SIZE = "250";
    expect(await requestedPageSize()).toBe(250);
  });

  it("clamps a CURSOR_PAGE_SIZE above the ceiling", async () => {
    process.env.CURSOR_PAGE_SIZE = "5000";
    expect(await requestedPageSize()).toBe(1000);
  });

  it("keeps the page size stable when the environment changes mid-read", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    process.env.CURSOR_PAGE_SIZE = "250";
    fetchMock
      .mockImplementationOnce(() => {
        process.env.CURSOR_PAGE_SIZE = "10";
        return Promise.resolve(okResponse(makePage([makeEvent()], true, 250)));
      })
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false, 250)));

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }));

    expect(requestBody(fetchMock, 1).pageSize).toBe(250);
  });
});

describe("fetchEvents paging termination", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_SENTINEL);
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.REVENIUM_REQUEST_TIMEOUT_MS;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stops paging on an empty page even when hasNextPage is true", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([], true)));

    const { batches } = await settleWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
  });

  it("warns that the window may be truncated when a page is empty mid-read", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([], true)));

    await settleWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty page"));
  });

  it("fails the read after yielding what it managed to fetch from a truncated window", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([], true)));

    const { batches, error } = await settleWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(batches).toHaveLength(1);
    expect(error).toBeInstanceOf(CursorWindowTruncatedError);
  });

  it("does not let an empty page in one chunk block the next chunk", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const to = 45 * 24 * 60 * 60 * 1000;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([], true)))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const { batches, error } = await settleWithFakeTimers(
      fetchEvents(apiKey, 0, to, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
    expect(error).toBeInstanceOf(CursorWindowTruncatedError);
  });

  it("completes without error when every page the API reports is read", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], true)))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const { batches, error } = await settleWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(batches).toHaveLength(2);
    expect(error).toBeUndefined();
  });
});

describe("testConnectivity", () => {
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

  it("probes with a page size the Cursor API is known to accept", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okResponse(makePage([makeEvent()], false, 100)));

    const probe = testConnectivity(apiKey);
    await vi.runAllTimersAsync();

    expect(await probe).toBe(true);
    expect(requestBody(fetchMock, 0)).toMatchObject({ pageSize: 100, page: 1 });
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

  it("keeps the default 7500ms interval between full-size pages", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const fullPage = Array.from({ length: CURSOR_MAX_PAGE_SIZE }, () => makeEvent());
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage(fullPage, true)))
      .mockResolvedValueOnce(okResponse(makePage(fullPage, false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls(setTimeoutSpy)).toEqual([DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS]);
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

describe("fetchEvents numeric normalization", () => {
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

  async function fetchSingleEvent(raw: Record<string, unknown>): Promise<CursorUsageEvent> {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okResponse(makePage([raw as unknown as CursorUsageEvent], false)));
    const batches = await drainWithFakeTimers(fetchEvents(apiKey, 0, 1));
    return batches[0][0];
  }

  it("coerces a string timestamp to a number", async () => {
    const event = await fetchSingleEvent({ ...makeEvent(), timestamp: "1700000000000" });
    expect(event.timestamp).toBe(1_700_000_000_000);
  });

  it("coerces a string chargedCents to a number", async () => {
    const event = await fetchSingleEvent({ ...makeEvent(), chargedCents: "21.3623" });
    expect(event.chargedCents).toBe(21.3623);
  });

  it("nulls a non-numeric chargedCents", async () => {
    const event = await fetchSingleEvent({ ...makeEvent(), chargedCents: "not-a-number" });
    expect(event.chargedCents).toBeNull();
  });

  it("nulls an empty chargedCents", async () => {
    const event = await fetchSingleEvent({ ...makeEvent(), chargedCents: "" });
    expect(event.chargedCents).toBeNull();
  });

  it("nulls a whitespace-only chargedCents", async () => {
    const event = await fetchSingleEvent({ ...makeEvent(), chargedCents: "   " });
    expect(event.chargedCents).toBeNull();
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

  it("retries a reset connection then succeeds", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(transportFailure("ECONNRESET"))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
  });

  it("retries a refused connection then succeeds", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(transportFailure("ECONNREFUSED"))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));

    const batches = await drainWithFakeTimers(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
  });

  it("waits the pacing interval before a retried attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(transportFailure("ECONNRESET"))
      .mockResolvedValueOnce(okResponse(makePage([makeEvent()], false)));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await drainWithFakeTimers(fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 5000 }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const waitedMs = sleepCalls(setTimeoutSpy).reduce((total, ms) => total + ms, 0);
    expect(waitedMs).toBeGreaterThanOrEqual(5000);
  });

  it("does not retry a certificate failure and names its code", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(transportFailure("DEPTH_ZERO_SELF_SIGNED_CERT"));

    const captured = await drainCapturingError(
      fetchEvents(apiKey, 0, 1, { minRequestIntervalMs: 0 }),
    );

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
