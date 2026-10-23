import { fetchEvents } from "../cursor-client.js";
import { sendLogsWithResult } from "../../../_core/api/otlp-client.js";
import { startupStagger } from "../../../_core/api/resilience.js";
import { buildOtlpPayload, isValidTimestamp } from "../transform/otlp-mapper.js";
import { loadState, saveState } from "./state-manager.js";
import { computeEventHash } from "./deduplicator.js";
import { SentRecordLog, utcDayKey } from "../../../_core/sync/sent-record-log.js";
import { computeHeldWatermark } from "../../../_core/sync/retry-window.js";
import {
  DEFAULT_OVERLAP_MULTIPLIER,
  FIRST_RUN_LOOKBACK_MS,
  MAX_EVENTS_PER_BATCH,
  USAGE_RETENTION_DAYS,
} from "../../constants.js";
import type { CursorConfig, CursorUsageEvent, SyncResult } from "../../types.js";

export async function runSyncCycle(
  config: CursorConfig,
  fromOverride?: number,
  toOverride?: number,
): Promise<SyncResult> {
  const state = await loadState();
  const now = Date.now();

  const overlapMs = config.syncIntervalMs * DEFAULT_OVERLAP_MULTIPLIER;
  const retentionFloor = now - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const windowStartFor = (watermark: number): number =>
    watermark > 0 ? watermark - overlapMs : now - FIRST_RUN_LOOKBACK_MS;

  const from = fromOverride ?? windowStartFor(state.lastSyncTimestamp);
  const to = toOverride ?? now;

  if (from > to) {
    throw new Error(
      `Invalid sync window: start ${new Date(from).toISOString()} is after end ${new Date(to).toISOString()}. ` +
        "Saved sync progress may already be past --to.",
    );
  }

  const seenThisCycle = new SentRecordLog(state.sentRecords);
  const result: SyncResult = {
    fetched: 0,
    sent: 0,
    duplicatesSkipped: 0,
    invalidTimestampsSkipped: 0,
    errors: 0,
  };

  let pendingRecords: { event: CursorUsageEvent; hash: string }[] = [];
  const confirmedLog = new SentRecordLog(state.sentRecords);
  let confirmedWatermark = state.lastSyncTimestamp;
  let anyBatchFailed = false;

  const persistProgress = async (): Promise<void> => {
    const heldWatermark = computeHeldWatermark({
      requestedWindowStart: from,
      lastSyncTimestamp: state.lastSyncTimestamp,
      overlapMs,
      retentionFloor,
    });

    const persistedWatermark = anyBatchFailed ? heldWatermark : confirmedWatermark;
    const nextWindowStart = windowStartFor(persistedWatermark);
    const retainedStart =
      fromOverride === undefined ? nextWindowStart : Math.min(from, nextWindowStart);

    confirmedLog.pruneOutside(utcDayKey(retainedStart), utcDayKey(Math.max(to, now)));

    await saveState({
      lastSyncTimestamp: persistedWatermark,
      lastSyncEventCount: result.sent,
      totalEventsSynced: state.totalEventsSynced + result.sent,
      sentRecords: confirmedLog.toState(),
    });
  };

  const flushPending = async (): Promise<void> => {
    if (pendingRecords.length === 0) return;

    const { success, sent, error } = await sendBatch(
      pendingRecords.map((record) => record.event),
      config,
    );

    if (!success) {
      console.warn(
        `[cursor] Revenium refused ${pendingRecords.length} event(s); they stay in the sync window and are retried next cycle: ${error}`,
      );
      anyBatchFailed = true;
      result.errors += pendingRecords.length;
    } else {
      result.sent += sent;
      for (const { event, hash } of pendingRecords) {
        confirmedLog.mark(hash, event.timestamp);
        if (event.timestamp > confirmedWatermark) {
          confirmedWatermark = event.timestamp;
        }
      }
    }

    pendingRecords = [];
  };

  try {
    for await (const batch of fetchEvents(config.cursorApiKey, from, to)) {
      result.fetched += batch.length;

      for (const event of batch) {
        const hash = computeEventHash(event);

        if (seenThisCycle.isDuplicate(hash)) {
          result.duplicatesSkipped++;
          continue;
        }

        if (!isValidTimestamp(event.timestamp)) {
          result.invalidTimestampsSkipped++;
          continue;
        }

        seenThisCycle.mark(hash, event.timestamp);
        pendingRecords.push({ event, hash });

        if (pendingRecords.length >= MAX_EVENTS_PER_BATCH) {
          await flushPending();
        }
      }
    }

    await flushPending();
    await persistProgress();
  } catch (error) {
    anyBatchFailed = true;
    result.errors++;
    await persistProgress();
    throw error;
  }

  return result;
}

async function sendBatch(
  events: CursorUsageEvent[],
  config: CursorConfig,
): Promise<{ success: boolean; sent: number; error?: string }> {
  const payload = buildOtlpPayload(events, config);
  const { success, error } = await sendLogsWithResult(
    config.reveniumEndpoint,
    config.reveniumApiKey,
    payload,
  );

  return success
    ? { success: true, sent: events.length }
    : { success: false, sent: 0, error: error ?? "Unknown error" };
}

export class SyncWatcher {
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: (() => void) | null = null;

  constructor(private config: CursorConfig) {}

  async start(
    onCycle?: (result: SyncResult) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    this.running = true;
    await startupStagger();

    while (this.running) {
      try {
        const result = await runSyncCycle(this.config);
        onCycle?.(result);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
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
