import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimiterState,
  enforceRateLimit,
  DEFAULT_TARGET_TPS,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} from "../../../src/_core/api/rate-limiter.js";

describe("rate-limiter constants", () => {
  it("exports expected defaults", () => {
    expect(DEFAULT_TARGET_TPS).toBe(5);
    expect(MAX_BATCH_SIZE).toBe(100);
    expect(DEFAULT_BATCH_SIZE).toBe(10);
  });
});

describe("createRateLimiterState", () => {
  it("initializes nextAvailableTimeMs to approximately now", () => {
    const before = Date.now();
    const state = createRateLimiterState();
    const after = Date.now();
    expect(state.nextAvailableTimeMs).toBeGreaterThanOrEqual(before);
    expect(state.nextAvailableTimeMs).toBeLessThanOrEqual(after);
  });
});

describe("enforceRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns immediately for non-finite batchSize", async () => {
    const state = createRateLimiterState();
    const initial = state.nextAvailableTimeMs;

    await enforceRateLimit(state, { batchSize: NaN });
    expect(state.nextAvailableTimeMs).toBe(initial);

    await enforceRateLimit(state, { batchSize: 0 });
    expect(state.nextAvailableTimeMs).toBe(initial);

    await enforceRateLimit(state, { batchSize: -5 });
    expect(state.nextAvailableTimeMs).toBe(initial);

    await enforceRateLimit(state, { batchSize: Infinity });
    expect(state.nextAvailableTimeMs).toBe(initial);
  });

  it("returns immediately for non-finite targetTps", async () => {
    const state = createRateLimiterState();
    const initial = state.nextAvailableTimeMs;

    await enforceRateLimit(state, { batchSize: 10, targetTps: 0 });
    expect(state.nextAvailableTimeMs).toBe(initial);

    await enforceRateLimit(state, { batchSize: 10, targetTps: -1 });
    expect(state.nextAvailableTimeMs).toBe(initial);

    await enforceRateLimit(state, { batchSize: 10, targetTps: NaN });
    expect(state.nextAvailableTimeMs).toBe(initial);
  });

  it("sanitizes non-finite userDelayMs to 0 instead of disabling rate limit", async () => {
    const state = createRateLimiterState();
    const initial = state.nextAvailableTimeMs;

    await enforceRateLimit(state, { batchSize: 10, userDelayMs: NaN });
    expect(state.nextAvailableTimeMs).toBeGreaterThan(initial);

    const state2 = createRateLimiterState();
    const initial2 = state2.nextAvailableTimeMs;

    await enforceRateLimit(state2, { batchSize: 10, userDelayMs: Infinity });
    expect(state2.nextAvailableTimeMs).toBeGreaterThan(initial2);

    const state3 = createRateLimiterState();
    const initial3 = state3.nextAvailableTimeMs;

    await enforceRateLimit(state3, { batchSize: 10, userDelayMs: -1 });
    expect(state3.nextAvailableTimeMs).toBeGreaterThan(initial3);
  });

  it("does not sleep on the first call (no accumulated delay)", async () => {
    const state = createRateLimiterState();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = enforceRateLimit(state, { batchSize: 10 });
    await vi.runAllTimersAsync();
    await promise;

    const relevantCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0,
    );
    expect(relevantCalls).toHaveLength(0);
  });

  it("advances nextAvailableTimeMs by requiredInterval after call", async () => {
    const now = Date.now();
    const state = createRateLimiterState();

    const promise = enforceRateLimit(state, { batchSize: 10, targetTps: 5 });
    await vi.runAllTimersAsync();
    await promise;

    expect(state.nextAvailableTimeMs).toBe(now + 2000);
  });

  it("sleeps when called before nextAvailableTimeMs", async () => {
    const state = createRateLimiterState();

    const p1 = enforceRateLimit(state, { batchSize: 10, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p1;

    const nextAvailable = state.nextAvailableTimeMs;
    const now = Date.now();
    const expectedDelay = nextAvailable - now;

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const p2 = enforceRateLimit(state, { batchSize: 10, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p2;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0,
    );
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0][1]).toBe(expectedDelay);
  });

  it("does not sleep when enough time has elapsed (slow request simulation)", async () => {
    const state = createRateLimiterState();

    const p1 = enforceRateLimit(state, { batchSize: 5, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p1;

    vi.advanceTimersByTime(5000);

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const p2 = enforceRateLimit(state, { batchSize: 5, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p2;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0,
    );
    expect(sleepCalls).toHaveLength(0);
  });

  it("respects userDelayMs as minimum floor on first call", async () => {
    const state = createRateLimiterState();
    const now = Date.now();

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const p1 = enforceRateLimit(state, { batchSize: 1, targetTps: 5, userDelayMs: 5000 });
    await vi.runAllTimersAsync();
    await p1;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0,
    );
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0][1]).toBe(5000);

    const requiredInterval = (1 / 5) * 1000;
    expect(state.nextAvailableTimeMs).toBe(now + 5000 + requiredInterval);
  });

  it("uses userDelayMs when larger than calculated delay on subsequent calls", async () => {
    const state = createRateLimiterState();

    const p1 = enforceRateLimit(state, { batchSize: 1, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p1;

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const p2 = enforceRateLimit(state, { batchSize: 1, targetTps: 5, userDelayMs: 10000 });
    await vi.runAllTimersAsync();
    await p2;

    const sleepCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === "number" && call[1] > 0,
    );
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0][1]).toBe(10000);
  });

  it("calculates correct delay for batch size 100 at 5 TPS", async () => {
    const state = createRateLimiterState();

    const p1 = enforceRateLimit(state, { batchSize: 100, targetTps: 5 });
    await vi.runAllTimersAsync();
    await p1;

    const requiredInterval = (100 / 5) * 1000;
    expect(state.nextAvailableTimeMs).toBe(Date.now() + requiredInterval);
  });

  it("handles sequential batches with consistent timing", async () => {
    const state = createRateLimiterState();
    const startTime = Date.now();

    for (let i = 0; i < 5; i++) {
      const p = enforceRateLimit(state, { batchSize: 5, targetTps: 5 });
      await vi.runAllTimersAsync();
      await p;
    }

    expect(state.nextAvailableTimeMs).toBe(startTime + 5 * 1000);
  });
});
