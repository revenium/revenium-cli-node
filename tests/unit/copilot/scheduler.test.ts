import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchUsageDays = vi.fn();
const sendTracesWithResult = vi.fn();
const loadState = vi.fn();
const saveState = vi.fn();

vi.mock("../../../src/copilot/core/github-client.js", () => ({
  fetchUsageDays: (...args: unknown[]) => fetchUsageDays(...args),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendTracesWithResult: (...args: unknown[]) => sendTracesWithResult(...args),
}));

vi.mock("../../../src/copilot/core/sync/state-manager.js", () => ({
  loadState: (...args: unknown[]) => loadState(...args),
  saveState: (...args: unknown[]) => saveState(...args),
}));

import { runSyncCycle } from "../../../src/copilot/core/sync/scheduler.js";
import { createBillingReport } from "../../../src/copilot/core/billing-match.js";
import { computeBreakdownHash } from "../../../src/copilot/core/sync/deduplicator.js";
import { SentRecordLog, utcDayKey } from "../../../src/_core/sync/sent-record-log.js";
import { DEFAULT_OVERLAP_DAYS, USAGE_RETENTION_DAYS } from "../../../src/copilot/constants.js";
import type {
  CopilotConfig,
  CopilotUsageBreakdown,
  CopilotUsageDay,
  SyncState,
} from "../../../src/copilot/types.js";
import type { OTLPTracesPayload } from "../../../src/_core/types/index.js";

const CONFIG = {
  reveniumApiKey: "key",
  reveniumEndpoint: "https://endpoint",
  syncIntervalMs: 1000,
} as CopilotConfig;

const CREDENTIAL = { token: "token", orgName: "acme" };

function breakdown(overrides: Partial<CopilotUsageBreakdown>): CopilotUsageBreakdown {
  return {
    language: "typescript",
    editor: "vscode",
    model: "claude-sonnet-4.6",
    user_login: "dev",
    cost_usd: 0,
    suggestions_count: 10,
    acceptances_count: 4,
    lines_suggested: 20,
    lines_accepted: 8,
    active_users: 1,
    input_tokens: 100,
    output_tokens: 50,
    ai_credits: 2,
    ...overrides,
  };
}

const DAY: CopilotUsageDay = {
  day: "2026-06-03",
  total_suggestions_count: 20,
  total_acceptances_count: 8,
  total_lines_suggested: 40,
  total_lines_accepted: 16,
  total_active_users: 2,
  total_chat_acceptances: 3,
  total_chat_turns: 6,
  total_active_chat_users: 2,
  breakdown: [breakdown({ user_login: "dev" }), breakdown({ user_login: "other", model: "gpt-5" })],
};

const INITIAL_STATE: SyncState = {
  lastSyncTimestamp: new Date("2026-06-01").getTime(),
  lastSyncEventCount: 0,
  totalEventsSynced: 0,
  sentRecords: {},
};

function sentRecordsFor(...days: CopilotUsageDay[]): Record<string, string[]> {
  const log = new SentRecordLog({});
  for (const day of days) {
    for (const item of day.breakdown) {
      log.mark(computeBreakdownHash(day, item), new Date(day.day).getTime());
    }
  }
  return log.toState();
}

function yieldDays(...pages: CopilotUsageDay[][]) {
  fetchUsageDays.mockImplementation(async function* () {
    for (const days of pages) {
      yield { days, unmatchedBilling: [], billingUnavailable: [] };
    }
  });
}

const NOW = new Date("2026-06-04").getTime();

const DAY_MS = 24 * 60 * 60 * 1000;

const OVERLAP_MS = DEFAULT_OVERLAP_DAYS * DAY_MS;

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

describe("runSyncCycle organization reachability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchUsageDays.mockReset();
  });

  it("fails the cycle naming the organization instead of reporting an empty fetch", async () => {
    const client = await vi.importActual<
      typeof import("../../../src/copilot/core/github-client.js")
    >("../../../src/copilot/core/github-client.js");
    fetchUsageDays.mockImplementation(client.fetchUsageDays);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { get: () => null },
        text: async () => '{"message":"Not Found"}',
      })),
    );

    await expect(
      runSyncCycle(
        CONFIG,
        { token: "token", orgName: "revenium-no-such-org" },
        { billingReport: createBillingReport() },
      ),
    ).rejects.toThrow("revenium-no-such-org");

    expect(sendTracesWithResult).not.toHaveBeenCalled();
  });
});

describe("runSyncCycle billing report", () => {
  it("keeps the warnings collected before a failure", async () => {
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [{ day: "2026-06-03", model: "Gemini 3 Pro", cost_usd: 4 }],
        billingUnavailable: [
          {
            day: "2026-06-04",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 3,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
      throw new Error("GitHub API unavailable");
    });

    const billingReport = createBillingReport();

    await expect(runSyncCycle(CONFIG, CREDENTIAL, { billingReport })).rejects.toThrow(
      "GitHub API unavailable",
    );

    expect(billingReport.unmatched).toEqual([
      { day: "2026-06-03", model: "Gemini 3 Pro", cost_usd: 4 },
    ]);
    expect(billingReport.unavailable).toEqual([
      {
        day: "2026-06-04",
        reason: "GitHub API 403 Forbidden",
        withheldRecords: 3,
        zeroCostRecords: 0,
        unresolved: true,
      },
    ]);
  });

  it("reports billing warnings for a run that sends no usage", async () => {
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [{ day: "2026-06-03", model: "Claude Sonnet 4.6", cost_usd: 2.5 }],
        billingUnavailable: [],
      };
    });

    const billingReport = createBillingReport();

    const { result } = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport });

    expect(result.sent).toBe(0);
    expect(sendTracesWithResult).not.toHaveBeenCalled();
    expect(billingReport.unmatched).toEqual([
      { day: "2026-06-03", model: "Claude Sonnet 4.6", cost_usd: 2.5 },
    ]);
  });
});

describe("runSyncCycle delivery guarantees", () => {
  it("a refused cycle persists no hashes and does not advance the watermark", async () => {
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    const { result } = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(result).toEqual({ fetched: 2, sent: 0, duplicatesSkipped: 0, errors: 2 });
    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 0,
      totalEventsSynced: 0,
      sentRecords: {},
    });
  });

  it("holds the watermark at the earliest day whose records were withheld", async () => {
    const withheldDay = "2026-06-02";
    const surfaceOnlyDay: CopilotUsageDay = {
      ...DAY,
      day: "2026-06-04",
      breakdown: [breakdown({ model: "copilot-completion", surface: "completion" })],
    };

    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [surfaceOnlyDay],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2026-06-03",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 2,
            zeroCostRecords: 0,
            unresolved: true,
          },
          {
            day: withheldDay,
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 1,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });
    sendTracesWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const saved = saveState.mock.calls[0][0] as SyncState;
    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(new Date(withheldDay).getTime());
  });

  it("advances the watermark when the failed billing lookup withheld nothing", async () => {
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [DAY],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2026-06-03",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });
    sendTracesWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const saved = saveState.mock.calls[0][0] as SyncState;
    expect(saved.lastSyncTimestamp).toBe(new Date(DAY.day).getTime());
  });

  it("a one-off --from run never rewinds the watermark the scheduled sync relies on", async () => {
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2026-05-20",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 5,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });

    await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      from: "2026-05-20",
    });

    const saved = saveState.mock.calls[0][0] as SyncState;
    expect(saved.lastSyncTimestamp).toBe(INITIAL_STATE.lastSyncTimestamp);
  });

  it("the next cycle resends breakdowns the previous cycle failed to deliver", async () => {
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    loadState.mockResolvedValue(saveState.mock.calls[0][0] as SyncState);
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const { result } = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(result.sent).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);

    const payload = sendTracesWithResult.mock.calls.at(-1)?.[2] as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("a 403 refusal is retried on the next cycle", async () => {
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 403 - forbidden",
    });

    const refused = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(refused.result.errors).toBe(2);

    loadState.mockResolvedValue(saveState.mock.calls[0][0] as SyncState);
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const retried = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(retried.result.sent).toBe(2);
  });

  it("accepted breakdowns are not sent again", async () => {
    loadState.mockResolvedValue({ ...INITIAL_STATE, sentRecords: sentRecordsFor(DAY) });
    yieldDays([DAY]);

    const { result } = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(result.duplicatesSkipped).toBe(2);
    expect(result.sent).toBe(0);
    expect(sendTracesWithResult).not.toHaveBeenCalled();
  });

  it("keeps the batch accepted before a mid-cycle refusal and retries only the refused one", async () => {
    const acceptedDay: CopilotUsageDay = {
      ...DAY,
      day: "2026-06-02",
      breakdown: Array.from({ length: 100 }, (_, index) =>
        breakdown({ user_login: `dev-${index}` }),
      ),
    };
    const refusedDay: CopilotUsageDay = {
      ...DAY,
      day: "2026-06-03",
      breakdown: Array.from({ length: 50 }, (_, index) =>
        breakdown({ user_login: `other-${index}` }),
      ),
    };

    yieldDays([acceptedDay, refusedDay]);
    sendTracesWithResult.mockResolvedValueOnce({ success: true }).mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    const { result } = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(result.sent).toBe(100);
    expect(result.errors).toBe(50);
    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 100,
      totalEventsSynced: 100,
      sentRecords: sentRecordsFor(acceptedDay),
    });

    loadState.mockResolvedValue(saveState.mock.calls[0][0] as SyncState);
    yieldDays([acceptedDay, refusedDay]);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const retried = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
    });

    expect(retried.result.sent).toBe(50);
    expect(retried.result.duplicatesSkipped).toBe(100);
  });

  it("a window held open longer than the retention bound fetches from the bound itself", async () => {
    const stalledSince = NOW - 60 * DAY_MS;
    loadState.mockResolvedValue({ ...INITIAL_STATE, lastSyncTimestamp: stalledSince });
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(NOW - USAGE_RETENTION_DAYS * DAY_MS);
  });

  it("a refused historical range stays inside the next default window", async () => {
    yieldDays([DAY]);
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      from: "2026-05-25",
    });

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(new Date("2026-05-25").getTime());
  });

  it("a refused historical batch keeps its retry date when the same run withheld a later day", async () => {
    loadState.mockResolvedValue({
      ...INITIAL_STATE,
      lastSyncTimestamp: new Date("2026-06-04").getTime(),
    });
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [DAY],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: "2026-05-26",
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 2,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });
    sendTracesWithResult.mockResolvedValue({
      success: false,
      error: "OTLP request failed: 503 - unavailable",
    });

    await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      from: "2026-05-25",
    });

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(new Date("2026-05-25").getTime());
  });

  it("holds the window on a failed billing lookup that withheld no usage row", async () => {
    const withheldDay = "2026-06-02";
    loadState.mockResolvedValue({
      ...INITIAL_STATE,
      lastSyncTimestamp: new Date("2026-06-04").getTime(),
    });
    fetchUsageDays.mockImplementation(async function* () {
      yield {
        days: [],
        unmatchedBilling: [],
        billingUnavailable: [
          {
            day: withheldDay,
            reason: "GitHub API 403 Forbidden",
            withheldRecords: 0,
            zeroCostRecords: 0,
            unresolved: true,
          },
        ],
      };
    });
    sendTracesWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const saved = saveState.mock.calls[0][0] as SyncState;

    expect(saved.lastSyncTimestamp - OVERLAP_MS).toBe(new Date(withheldDay).getTime());
  });

  it("hashes confirmed before a fetch failure survive the rethrow", async () => {
    const firstDay: CopilotUsageDay = {
      ...DAY,
      breakdown: Array.from({ length: 100 }, (_, index) =>
        breakdown({ user_login: `dev-${index}` }),
      ),
    };

    fetchUsageDays.mockImplementation(async function* () {
      yield { days: [firstDay], unmatchedBilling: [], billingUnavailable: [] };
      throw new Error("GitHub API unavailable");
    });
    sendTracesWithResult.mockResolvedValue({ success: true });

    await expect(
      runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() }),
    ).rejects.toThrow("GitHub API unavailable");

    expect(saveState).toHaveBeenCalledWith({
      lastSyncTimestamp: INITIAL_STATE.lastSyncTimestamp,
      lastSyncEventCount: 100,
      totalEventsSynced: 100,
      sentRecords: sentRecordsFor(firstDay),
    });
  });

  it("a second cycle over a window larger than the former hash cap sends nothing", async () => {
    const crowdedDays = ["2026-06-02", "2026-06-03"].map((day) => ({
      ...DAY,
      day,
      breakdown: Array.from({ length: 52_500 }, (_, index) =>
        breakdown({ user_login: `dev-${day}-${index}` }),
      ),
    }));

    yieldDays(crowdedDays);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    expect(first.result.sent).toBe(105_000);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendTracesWithResult.mockClear();
    yieldDays(crowdedDays);

    const second = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    expect(second.result.sent).toBe(0);
    expect(second.result.duplicatesSkipped).toBe(105_000);
    expect(sendTracesWithResult).not.toHaveBeenCalled();

    const newcomers = {
      ...crowdedDays[1],
      breakdown: [
        ...crowdedDays[1].breakdown,
        ...Array.from({ length: 500 }, (_, index) =>
          breakdown({ user_login: `newcomer-${index}` }),
        ),
      ],
    };

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendTracesWithResult.mockResolvedValue({ success: true });
    yieldDays([crowdedDays[0], newcomers]);

    const third = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    expect(third.result.sent).toBe(500);
    expect(third.result.duplicatesSkipped).toBe(105_000);
  });

  it("a second cycle with progress older than the retention bound sends nothing", async () => {
    const stalledDay = "2026-04-20";
    const days = [{ ...DAY, day: stalledDay, breakdown: [breakdown({ user_login: "dev" })] }];

    loadState.mockResolvedValue({
      ...INITIAL_STATE,
      lastSyncTimestamp: new Date(stalledDay).getTime(),
    });
    yieldDays(days);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    expect(first.result.sent).toBe(1);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendTracesWithResult.mockClear();
    yieldDays(days);

    const second = await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    expect(second.result.sent).toBe(0);
    expect(second.result.duplicatesSkipped).toBe(1);
    expect(sendTracesWithResult).not.toHaveBeenCalled();
  });

  it("persists only the day buckets the next window will re-read", async () => {
    const days = ["2026-05-30", "2026-06-02", "2026-06-03"].map((day) => ({
      ...DAY,
      day,
      breakdown: [breakdown({ user_login: `dev-${day}` })],
    }));

    yieldDays(days);
    sendTracesWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const saved = saveState.mock.calls.at(-1)?.[0] as SyncState;

    expect(Object.keys(saved.sentRecords)).toEqual([
      utcDayKey(saved.lastSyncTimestamp - OVERLAP_MS),
      "2026-06-03",
    ]);
  });

  it("keeps the buckets of an explicit past window so re-running it sends nothing", async () => {
    const days = ["2026-05-05", "2026-05-06"].map((day) => ({
      ...DAY,
      day,
      breakdown: [breakdown({ user_login: `dev-${day}` })],
    }));

    yieldDays(days);
    sendTracesWithResult.mockResolvedValue({ success: true });

    const first = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      from: "2026-05-05",
      to: "2026-05-06",
    });

    expect(first.result.sent).toBe(2);

    loadState.mockResolvedValue(saveState.mock.calls.at(-1)?.[0] as SyncState);
    sendTracesWithResult.mockClear();
    yieldDays(days);

    const second = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      from: "2026-05-05",
      to: "2026-05-06",
    });

    expect(second.result.sent).toBe(0);
    expect(second.result.duplicatesSkipped).toBe(2);
    expect(sendTracesWithResult).not.toHaveBeenCalled();
  });

  it("splits a single day that holds more records than one batch", async () => {
    const crowdedDay: CopilotUsageDay = {
      ...DAY,
      breakdown: Array.from({ length: 250 }, (_, index) =>
        breakdown({ user_login: `dev-${index}` }),
      ),
    };

    yieldDays([crowdedDay]);
    sendTracesWithResult.mockResolvedValue({ success: true });

    await runSyncCycle(CONFIG, CREDENTIAL, { billingReport: createBillingReport() });

    const spanCounts = sendTracesWithResult.mock.calls.map(
      ([, , payload]) => (payload as OTLPTracesPayload).resourceSpans[0].scopeSpans[0].spans.length,
    );
    expect(spanCounts).toEqual([100, 100, 50]);
  });

  it("a dry run writes no state", async () => {
    yieldDays([DAY]);

    const { result, dryRunPayloads } = await runSyncCycle(CONFIG, CREDENTIAL, {
      billingReport: createBillingReport(),
      dryRun: true,
    });

    expect(result.sent).toBe(2);
    expect(dryRunPayloads).toHaveLength(1);
    expect(saveState).not.toHaveBeenCalled();
    expect(sendTracesWithResult).not.toHaveBeenCalled();
  });
});
