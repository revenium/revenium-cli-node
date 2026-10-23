import { fetchUsageDays } from "../github-client.js";
import { sendTracesWithResult } from "../../../_core/api/otlp-client.js";
import { startupStagger } from "../../../_core/api/resilience.js";
import { buildOtlpPayload, isValidDay } from "../transform/otlp-mapper.js";
import {
  clearCostsAlreadyImportedAsBilling,
  createBillingReport,
  recordBillingFetch,
} from "../billing-match.js";
import { loadState, saveState } from "./state-manager.js";
import { computeBreakdownHash } from "./deduplicator.js";
import { appendBreakdown } from "./pending-days.js";
import { SentRecordLog, utcDayKey } from "../../../_core/sync/sent-record-log.js";
import { computeHeldWatermark } from "../../../_core/sync/retry-window.js";
import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_OVERLAP_DAYS,
  MAX_EVENTS_PER_BATCH,
  USAGE_RETENTION_DAYS,
} from "../../constants.js";
import type { GithubCredential } from "../../config/github-credential.js";
import type {
  BillingReport,
  CopilotConfig,
  CopilotUsageDay,
  CopilotUsageFetch,
  SyncResult,
} from "../../types.js";

export interface SyncCycleOptions {
  billingReport: BillingReport;
  from?: string;
  to?: string;
  dryRun?: boolean;
  allowMissingBilling?: boolean;
}

function earliestWithheldDay(fetch: CopilotUsageFetch, current: number | null): number | null {
  let earliest = current;

  for (const entry of fetch.billingUnavailable) {
    if (!entry.unresolved) continue;

    const dayMs = new Date(entry.day).getTime();
    if (earliest === null || dayMs < earliest) {
      earliest = dayMs;
    }
  }

  return earliest;
}

export async function runSyncCycle(
  config: CopilotConfig,
  githubCredential: GithubCredential,
  options: SyncCycleOptions,
): Promise<{ result: SyncResult; dryRunPayloads?: object[] }> {
  const {
    billingReport,
    from: fromOverride,
    to: toOverride,
    dryRun = false,
    allowMissingBilling = false,
  } = options;
  const state = await loadState();
  const now = Date.now();

  const overlapMs = DEFAULT_OVERLAP_DAYS * 24 * 60 * 60 * 1000;
  const retentionFloor = now - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const windowStartFor = (watermark: number): number =>
    watermark > 0 ? watermark - overlapMs : now - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const windowStart = fromOverride
    ? new Date(fromOverride).getTime()
    : windowStartFor(state.lastSyncTimestamp);

  const since = utcDayKey(windowStart);

  const until = toOverride ?? utcDayKey(now);

  const seenThisCycle = new SentRecordLog(state.sentRecords);
  const result: SyncResult = {
    fetched: 0,
    sent: 0,
    duplicatesSkipped: 0,
    errors: 0,
  };

  let pendingDays: CopilotUsageDay[] = [];
  let pendingRecords: { hash: string; timestampMs: number }[] = [];
  const confirmedLog = new SentRecordLog(state.sentRecords);
  let confirmedWatermark = state.lastSyncTimestamp;
  let holdWindow = false;
  let withheldDayStart: number | null = null;
  const dryRunPayloads: object[] = [];

  const watermarkToPersist = (): number => {
    const delivered = holdWindow
      ? computeHeldWatermark({
          requestedWindowStart: windowStart,
          lastSyncTimestamp: state.lastSyncTimestamp,
          overlapMs,
          retentionFloor,
        })
      : confirmedWatermark;

    if (withheldDayStart === null) return delivered;

    const heldAtWithheldDay = Math.max(withheldDayStart, retentionFloor) + overlapMs;
    const scheduledProgressFloor = fromOverride && !holdWindow ? state.lastSyncTimestamp : 0;

    return Math.max(Math.min(delivered, heldAtWithheldDay), scheduledProgressFloor);
  };

  const persistProgress = async (): Promise<void> => {
    if (dryRun) return;

    const persistedWatermark = watermarkToPersist();
    const nextWindowStart = windowStartFor(persistedWatermark);
    const retainedStart = fromOverride ? Math.min(windowStart, nextWindowStart) : nextWindowStart;
    const today = utcDayKey(now);

    confirmedLog.pruneOutside(utcDayKey(retainedStart), until > today ? until : today);

    await saveState({
      lastSyncTimestamp: persistedWatermark,
      lastSyncEventCount: result.sent,
      totalEventsSynced: state.totalEventsSynced + result.sent,
      sentRecords: confirmedLog.toState(),
    });
  };

  const flushPending = async (): Promise<void> => {
    if (pendingDays.length === 0) return;

    const { success, sent, error } = await sendBatch(pendingDays, config, dryRun, dryRunPayloads);

    if (!success) {
      console.warn(
        `[copilot] Revenium refused ${pendingRecords.length} event(s); they stay in the sync window and are retried next cycle: ${error}`,
      );
      holdWindow = true;
      result.errors += pendingRecords.length;
    } else {
      result.sent += sent;
      for (const record of pendingRecords) {
        confirmedLog.mark(record.hash, record.timestampMs);
      }
      for (const day of pendingDays) {
        const dayTimestamp = new Date(day.day).getTime();
        if (dayTimestamp > confirmedWatermark) {
          confirmedWatermark = dayTimestamp;
        }
      }
    }

    pendingDays = [];
    pendingRecords = [];
  };

  try {
    for await (const usageFetch of fetchUsageDays(
      githubCredential.token,
      githubCredential.orgName,
      since,
      until,
      { allowMissingBilling },
    )) {
      recordBillingFetch(billingReport, usageFetch);
      withheldDayStart = earliestWithheldDay(usageFetch, withheldDayStart);

      for (const day of usageFetch.days) {
        if (!isValidDay(day.day)) continue;

        clearCostsAlreadyImportedAsBilling(day.breakdown, (breakdown) =>
          seenThisCycle.isDuplicate(computeBreakdownHash(day, breakdown)),
        );

        const dayTimestamp = new Date(day.day).getTime();

        for (const breakdown of day.breakdown) {
          const hash = computeBreakdownHash(day, breakdown);
          result.fetched++;

          if (seenThisCycle.isDuplicate(hash)) {
            result.duplicatesSkipped++;
            continue;
          }

          seenThisCycle.mark(hash, dayTimestamp);
          appendBreakdown(pendingDays, day, breakdown);
          pendingRecords.push({ hash, timestampMs: dayTimestamp });

          if (pendingRecords.length >= MAX_EVENTS_PER_BATCH) {
            await flushPending();
          }
        }
      }
    }

    await flushPending();
    await persistProgress();
  } catch (error) {
    holdWindow = true;
    result.errors++;
    await persistProgress();
    throw error;
  }

  return { result, dryRunPayloads: dryRun ? dryRunPayloads : undefined };
}

async function sendBatch(
  days: CopilotUsageDay[],
  config: CopilotConfig,
  dryRun: boolean,
  dryRunPayloads: object[],
): Promise<{ success: boolean; sent: number; error?: string }> {
  const payload = buildOtlpPayload(days, config);
  const recordCount = days.reduce((sum, d) => sum + d.breakdown.length, 0);

  if (dryRun) {
    dryRunPayloads.push(payload);
    return { success: true, sent: recordCount };
  }

  const { success, error } = await sendTracesWithResult(
    config.reveniumEndpoint,
    config.reveniumApiKey,
    payload,
  );

  return success
    ? { success: true, sent: recordCount }
    : { success: false, sent: 0, error: error ?? "Unknown error" };
}

export class SyncWatcher {
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: (() => void) | null = null;

  constructor(
    private config: CopilotConfig,
    private githubCredential: GithubCredential,
    private allowMissingBilling = false,
  ) {}

  async start(
    onCycle?: (result: SyncResult, billingReport: BillingReport) => void,
    onError?: (error: Error, billingReport: BillingReport) => void,
  ): Promise<void> {
    this.running = true;
    await startupStagger();

    while (this.running) {
      const billingReport = createBillingReport();

      try {
        const { result } = await runSyncCycle(this.config, this.githubCredential, {
          billingReport,
          allowMissingBilling: this.allowMissingBilling,
        });
        onCycle?.(result, billingReport);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)), billingReport);
      }

      if (!this.running) break;

      await new Promise<void>((resolve) => {
        this.resolveWait = resolve;
        this.timeoutId = setTimeout(resolve, this.config.syncIntervalMs);
      });
      this.resolveWait = null;
    }
  }

  stop(): void {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.resolveWait) {
      this.resolveWait();
      this.resolveWait = null;
    }
  }
}
