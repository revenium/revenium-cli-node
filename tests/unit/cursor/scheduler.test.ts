import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchEvents = vi.fn();
const sendLogsWithResult = vi.fn();
const loadState = vi.fn();
const saveState = vi.fn();

vi.mock("../../../src/cursor/core/cursor-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/cursor/core/cursor-client.js")>()),
  fetchEvents: (...args: unknown[]) => fetchEvents(...args),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendLogsWithResult: (...args: unknown[]) => sendLogsWithResult(...args),
}));

vi.mock("../../../src/cursor/core/sync/state-manager.js", () => ({
  loadState: (...args: unknown[]) => loadState(...args),
  saveState: (...args: unknown[]) => saveState(...args),
}));

import { runSyncCycle } from "../../../src/cursor/core/sync/scheduler.js";
import { CursorWindowTruncatedError } from "../../../src/cursor/core/cursor-client.js";
import { computeEventHash } from "../../../src/cursor/core/sync/deduplicator.js";
import { SentRecordLog } from "../../../src/_core/sync/sent-record-log.js";
import { DEFAULT_OVERLAP_MULTIPLIER, USAGE_RETENTION_DAYS } from "../../../src/cursor/constants.js";
import type { CursorConfig, CursorUsageEvent, SyncState } from "../../../src/cursor/types.js";

const CONFIG = {
  cursorApiKey: "cursor-key",
  reveniumApiKey: "revenium-key",
  reveniumEndpoint: "https://endpoint",
  syncIntervalMs: 60_000,
} as CursorConfig;

const EVENTS: CursorUsageEvent[] = [
  {
    timestamp: 1_760_000_000_000,
    model: "claude-sonnet-4.6",
    kind: "composer",
    userEmail: "dev@acme.io",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 10,
      cacheReadTokens: 5,
      totalCents: 3,
    },
  },
  {
    timestamp: 1_760_000_060_000,
    model: "gpt-5",
    kind: "chat",
    userEmail: "dev@acme.io",
    tokenUsage: {
      inputTokens: 200,
      outputTokens: 80,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: 7,
    },
  },
];

const INITIAL_STATE: SyncState = {
  lastSyncTimestamp: 1_759_000_000_000,
  lastSyncEventCount: 0,
  totalEventsSynced: 0,
  sentRecords: {},
};

function sentRecordsFor(events: CursorUsageEvent[]): Record<string, string[]> {
  const log = new SentRecordLog({});
  for (const event of events) {
    log.mark(computeEventHash(event), event.timestamp);
  }
  return log.toState();
}

function yieldPages(...pages: CursorUsageEvent[][]) {
  fetchEvents.mockImplementation(async function* () {
    for (const page of pages) {
      yield page;
    }
  });
}

const NOW = 1_760_000_100_000;

const OVERLAP_MS = CONFIG.syncIntervalMs * DEFAULT_OVERLAP_MULTIPLIER;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  loadState.mockResolvedValue(INITIAL_STATE);
  saveState.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runSyncCycle window validation", () => {
  it("fails a --to that saved progress has already passed instead of reporting an empty success", async () => {
    await expect(
      runSyncCycle(CONFIG, undefined, INITIAL_STATE.lastSyncTimestamp - OVERLAP_MS - 1),
    ).rejects.toThrow("Invalid sync window");

    expect(fetchEvents).not.toHaveBeenCalled();
  });
});

describe("runSyncCycle delivery guarantees", () => {
  it("a refused cycle persists no hashes and does not advance the watermark", async () => {
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    const result = await runSyncCycle(CONFIG);

    expect(result).toEqual({
      fetched: 2,
      sent: 0,
      duplicatesSkipped: 0,
      invalidTimestampsSkipped: 0,
      errors: 2,
    });
    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 0,
      totalEventsSynced: 0,
      sentRecords: {},
    });
  });

  it("a window Cursor cut short holds the watermark back instead of skipping the unread events", async () => {
    fetchEvents.mockImplementation(async function* () {
      yield EVENTS;
      throw new CursorWindowTruncatedError(1);
    });
    sendLogsWithResult.mockResolvedValue({ success: true });

    await expect(runSyncCycle(CONFIG)).rejects.toBeInstanceOf(CursorWindowTruncatedError);

    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp }),
    );
  });

  it("the next cycle resends events the previous cycle failed to deliver", async () => {
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG);

    const refusedState = saveState.mock.calls[0][0] as SyncState;
    loadState.mockResolvedValue({ ...INITIAL_STATE, ...refusedState });
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const result = await runSyncCycle(CONFIG);

    expect(result.sent).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);

    const payload = sendLogsWithResult.mock.calls.at(-1)?.[2] as {
      resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[];
    };
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
  });

  it("a 403 refusal is retried on the next cycle", async () => {
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 403 - forbidden",
    });

    const result = await runSyncCycle(CONFIG);

    expect(result.errors).toBe(2);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        sentRecords: {},
        lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      }),
    );

    loadState.mockResolvedValue(saveState.mock.calls[0][0] as SyncState);
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({ success: true });

    expect((await runSyncCycle(CONFIG)).sent).toBe(2);
  });

  it("accepted events are not sent again", async () => {
    loadState.mockResolvedValue({
      ...INITIAL_STATE,
      sentRecords: sentRecordsFor(EVENTS),
    });
    yieldPages(EVENTS);

    const result = await runSyncCycle(CONFIG);

    expect(result.duplicatesSkipped).toBe(2);
    expect(result.sent).toBe(0);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });

  it("keeps the batch accepted before a mid-cycle refusal and retries only the refused one", async () => {
    const events = Array.from({ length: 150 }, (_, index) => ({
      ...EVENTS[0],
      timestamp: EVENTS[0].timestamp + index,
    }));

    yieldPages(events);
    sendLogsWithResult.mockResolvedValueOnce({ success: true }).mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    const result = await runSyncCycle(CONFIG);

    expect(result.sent).toBe(100);
    expect(result.errors).toBe(50);
    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 100,
      totalEventsSynced: 100,
      sentRecords: sentRecordsFor(events.slice(0, 100)),
    });

    loadState.mockResolvedValue({
      ...INITIAL_STATE,
      ...(saveState.mock.calls[0][0] as SyncState),
    });
    yieldPages(events);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const retried = await runSyncCycle(CONFIG);

    expect(retried.sent).toBe(50);
    expect(retried.duplicatesSkipped).toBe(100);
  });

  it("a window held open longer than the retention bound fetches from the bound itself", async () => {
    const stalledSince = NOW - 60 * 24 * 60 * 60 * 1000;
    loadState.mockResolvedValue({ ...INITIAL_STATE, lastSyncTimestamp: stalledSince });
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG);

    const retentionFloor = NOW - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(retentionFloor);
  });

  it("a refused first cycle keeps the first-run window instead of widening it to the retention bound", async () => {
    loadState.mockResolvedValue({ ...INITIAL_STATE, lastSyncTimestamp: 0 });
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG);

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(NOW - 24 * 60 * 60 * 1000);
  });

  it("a refused historical range stays inside the next default window", async () => {
    const historicalFrom = NOW - 20 * 24 * 60 * 60 * 1000;
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, historicalFrom);

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(historicalFrom);
  });

  it("a refused range newer than the watermark does not move the watermark forward", async () => {
    yieldPages(EVENTS);
    sendLogsWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, NOW - 60 * 1000);

    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp }),
    );
  });

  it("a second cycle over a window larger than the former hash cap sends nothing", async () => {
    const events = Array.from({ length: 12_000 }, (_, index) => ({
      ...EVENTS[0],
      timestamp: EVENTS[0].timestamp + index,
    }));

    yieldPages(events);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG);

    expect(first.sent).toBe(12_000);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendLogsWithResult.mockClear();
    yieldPages(events);

    const second = await runSyncCycle(CONFIG);

    expect(second.sent).toBe(0);
    expect(second.duplicatesSkipped).toBe(12_000);
    expect(sendLogsWithResult).not.toHaveBeenCalled();

    const newcomers = Array.from({ length: 500 }, (_, index) => ({
      ...EVENTS[1],
      timestamp: EVENTS[1].timestamp + index,
    }));

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendLogsWithResult.mockResolvedValue({ success: true });
    yieldPages([...events, ...newcomers]);

    const third = await runSyncCycle(CONFIG);

    expect(third.sent).toBe(500);
    expect(third.duplicatesSkipped).toBe(12_000);
  });

  it("a second cycle with progress older than the retention bound sends nothing", async () => {
    const stalledAt = NOW - (USAGE_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000;
    const events = [EVENTS[0], EVENTS[1]].map((event, index) => ({
      ...event,
      timestamp: stalledAt - index * 60 * 1000,
    }));

    loadState.mockResolvedValue({ ...INITIAL_STATE, lastSyncTimestamp: stalledAt });
    yieldPages(events);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG);

    expect(first.sent).toBe(2);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendLogsWithResult.mockClear();
    yieldPages(events);

    const second = await runSyncCycle(CONFIG);

    expect(second.sent).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });

  it("skips an event whose timestamp no day bucket can hold instead of failing the cycle", async () => {
    yieldPages([{ ...EVENTS[0], timestamp: 1.7e18 }, EVENTS[1]]);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const result = await runSyncCycle(CONFIG);

    expect(result.invalidTimestampsSkipped).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("keeps the day buckets of an explicit past window so re-running it sends nothing", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const events = [USAGE_RETENTION_DAYS + 10, USAGE_RETENTION_DAYS + 11].map((daysAgo) => ({
      ...EVENTS[0],
      timestamp: EVENTS[0].timestamp - daysAgo * dayMs,
    }));

    yieldPages(events);
    sendLogsWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG, events[1].timestamp, events[0].timestamp);

    expect(first.sent).toBe(2);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendLogsWithResult.mockClear();
    yieldPages(events);

    const second = await runSyncCycle(CONFIG, events[1].timestamp, events[0].timestamp);

    expect(second.sent).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });

  it("persists only the day buckets the next window will re-read", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const events = [0, 1, 2].map((daysAgo) => ({
      ...EVENTS[0],
      timestamp: EVENTS[0].timestamp - daysAgo * dayMs,
    }));

    yieldPages(events);
    sendLogsWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG);

    const saved = saveState.mock.calls.at(-1)?.[0] as SyncState;
    const floorDay = new Date(saved.lastSyncTimestamp - OVERLAP_MS).toISOString().slice(0, 10);

    expect(Object.keys(saved.sentRecords).every((day) => day >= floorDay)).toBe(true);
    expect(new SentRecordLog(saved.sentRecords).size()).toBe(1);
  });

  it("hashes confirmed before a fetch failure survive the rethrow", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...EVENTS[0],
      timestamp: EVENTS[0].timestamp + index,
    }));

    fetchEvents.mockImplementation(async function* () {
      yield firstPage;
      throw new Error("Cursor API unavailable");
    });
    sendLogsWithResult.mockResolvedValue({ success: true });

    await expect(runSyncCycle(CONFIG)).rejects.toThrow("Cursor API unavailable");

    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 100,
      totalEventsSynced: 100,
      sentRecords: sentRecordsFor(firstPage),
    });
  });
});
