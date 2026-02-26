import { fetchEvents } from "../cursor-client.js";
import { sendOtlpLogs } from "../../../_core/api/otlp-client.js";
import { buildOtlpPayload } from "../transform/otlp-mapper.js";
import { loadState, saveState } from "./state-manager.js";
import { Deduplicator, computeEventHash } from "./deduplicator.js";
import { DEFAULT_OVERLAP_MULTIPLIER, MAX_EVENTS_PER_BATCH } from "../../constants.js";
import type { CursorConfig, CursorUsageEvent, SyncResult } from "../../types.js";

export async function runSyncCycle(
  config: CursorConfig,
  fromOverride?: number,
  toOverride?: number,
): Promise<SyncResult> {
  const state = await loadState();
  const now = Date.now();

  const overlapMs = config.syncIntervalMs * DEFAULT_OVERLAP_MULTIPLIER;

  let from: number;
  if (fromOverride !== undefined) {
    from = fromOverride;
  } else if (state.lastSyncTimestamp > 0) {
    from = state.lastSyncTimestamp - overlapMs;
  } else {
    from = now - 24 * 60 * 60 * 1000;
  }

  const to = toOverride ?? now;

  const deduplicator = new Deduplicator(state.recentHashes);
  const result: SyncResult = {
    fetched: 0,
    sent: 0,
    duplicatesSkipped: 0,
    errors: 0,
  };

  let pendingEvents: CursorUsageEvent[] = [];
  let highWatermark = state.lastSyncTimestamp;

  try {
    for await (const batch of fetchEvents(config.cursorApiKey, from, to)) {
      result.fetched += batch.length;

      for (const event of batch) {
        const hash = computeEventHash(event);

        if (deduplicator.isDuplicate(hash)) {
          result.duplicatesSkipped++;
          continue;
        }

        deduplicator.mark(hash);
        pendingEvents.push(event);

        if (event.timestamp > highWatermark) {
          highWatermark = event.timestamp;
        }

        if (pendingEvents.length >= MAX_EVENTS_PER_BATCH) {
          const sent = await sendBatch(pendingEvents, config);
          result.sent += sent;
          if (sent < pendingEvents.length) {
            result.errors += pendingEvents.length - sent;
          }
          pendingEvents = [];
        }
      }
    }

    if (pendingEvents.length > 0) {
      const sent = await sendBatch(pendingEvents, config);
      result.sent += sent;
      if (sent < pendingEvents.length) {
        result.errors += pendingEvents.length - sent;
      }
    }

    if (result.errors === 0) {
      await saveState({
        lastSyncTimestamp: highWatermark > 0 ? highWatermark : state.lastSyncTimestamp,
        lastSyncEventCount: result.sent,
        totalEventsSynced: state.totalEventsSynced + result.sent,
        recentHashes: deduplicator.getHashes(),
      });
    }
  } catch (error) {
    result.errors++;
    throw error;
  }

  return result;
}

async function sendBatch(events: CursorUsageEvent[], config: CursorConfig): Promise<number> {
  const payload = buildOtlpPayload(events, config);

  try {
    await sendOtlpLogs(config.reveniumEndpoint, config.reveniumApiKey, payload);
    return events.length;
  } catch {
    return 0;
  }
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
