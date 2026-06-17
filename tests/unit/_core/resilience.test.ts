import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  jitteredBackoff,
  startupStagger,
  getMaxRetries,
  getRequestTimeoutMs,
  getBackoffBaseMs,
  getTargetTps,
  getStartupStaggerMs,
} from "../../../src/_core/api/resilience.js";

describe("jitteredBackoff", () => {
  it("returns value within expected range for each attempt", () => {
    const baseMs = 1000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const cap = baseMs * Math.pow(2, attempt);

      for (let i = 0; i < 100; i++) {
        const result = jitteredBackoff(attempt, baseMs);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(cap + 1);
      }
    }
  });

  it("never returns negative", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 50; i++) {
        expect(jitteredBackoff(attempt)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("uses default baseMs from getBackoffBaseMs when not provided", () => {
    const original = process.env.REVENIUM_BACKOFF_BASE_MS;
    delete process.env.REVENIUM_BACKOFF_BASE_MS;
    try {
      const result = jitteredBackoff(0);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(1001);
    } finally {
      if (original !== undefined) process.env.REVENIUM_BACKOFF_BASE_MS = original;
    }
  });

  it("respects custom baseMs", () => {
    const result = jitteredBackoff(0, 2000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(2001);
  });
});

describe("startupStagger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves within maxMs", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const promise = startupStagger(3000);
    await vi.runAllTimersAsync();
    await promise;

    const delayCalls = setTimeoutSpy.mock.calls.filter((call) => typeof call[1] === "number");
    if (delayCalls.length > 0) {
      expect(delayCalls[0][1]).toBeLessThan(3000);
      expect(delayCalls[0][1]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("env var getters", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns defaults when env vars are unset", () => {
    delete process.env.REVENIUM_MAX_RETRIES;
    delete process.env.REVENIUM_REQUEST_TIMEOUT_MS;
    delete process.env.REVENIUM_BACKOFF_BASE_MS;
    delete process.env.REVENIUM_TARGET_TPS;
    delete process.env.REVENIUM_STARTUP_STAGGER_MS;

    expect(getMaxRetries()).toBe(3);
    expect(getRequestTimeoutMs()).toBe(30_000);
    expect(getBackoffBaseMs()).toBe(1000);
    expect(getTargetTps()).toBe(1);
    expect(getStartupStaggerMs()).toBe(5000);
  });

  it("parses valid overrides", () => {
    process.env.REVENIUM_MAX_RETRIES = "5";
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = "60000";
    process.env.REVENIUM_BACKOFF_BASE_MS = "2000";
    process.env.REVENIUM_TARGET_TPS = "10.5";
    process.env.REVENIUM_STARTUP_STAGGER_MS = "8000";

    expect(getMaxRetries()).toBe(5);
    expect(getRequestTimeoutMs()).toBe(60000);
    expect(getBackoffBaseMs()).toBe(2000);
    expect(getTargetTps()).toBe(10.5);
    expect(getStartupStaggerMs()).toBe(8000);
  });

  it("ignores invalid string values", () => {
    process.env.REVENIUM_MAX_RETRIES = "abc";
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = "not-a-number";
    process.env.REVENIUM_BACKOFF_BASE_MS = "";
    process.env.REVENIUM_TARGET_TPS = "xyz";
    process.env.REVENIUM_STARTUP_STAGGER_MS = "foo";

    expect(getMaxRetries()).toBe(3);
    expect(getRequestTimeoutMs()).toBe(30_000);
    expect(getBackoffBaseMs()).toBe(1000);
    expect(getTargetTps()).toBe(1);
    expect(getStartupStaggerMs()).toBe(5000);
  });

  it("ignores zero values for positive-only params", () => {
    process.env.REVENIUM_MAX_RETRIES = "0";
    process.env.REVENIUM_TARGET_TPS = "0";

    expect(getMaxRetries()).toBe(3);
    expect(getTargetTps()).toBe(1);
  });

  it("allows zero for startup stagger to disable it", () => {
    process.env.REVENIUM_STARTUP_STAGGER_MS = "0";

    expect(getStartupStaggerMs()).toBe(0);
  });

  it("ignores negative values", () => {
    process.env.REVENIUM_MAX_RETRIES = "-1";
    process.env.REVENIUM_REQUEST_TIMEOUT_MS = "-5000";
    process.env.REVENIUM_TARGET_TPS = "-2.5";

    expect(getMaxRetries()).toBe(3);
    expect(getRequestTimeoutMs()).toBe(30_000);
    expect(getTargetTps()).toBe(1);
  });
});
