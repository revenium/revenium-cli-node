import { fetchUsageDays } from "../github-client.js";
import { sendOtlpTraces } from "../../../_core/api/otlp-client.js";
import { startupStagger } from "../../../_core/api/resilience.js";
import { buildOtlpPayload, isValidDay } from "../transform/otlp-mapper.js";
import { loadState, saveState } from "./state-manager.js";
import { Deduplicator, computeBreakdownHash } from "./deduplicator.js";
import { DEFAULT_OVERLAP_DAYS, MAX_EVENTS_PER_BATCH } from "../../constants.js";
import type { CopilotConfig, CopilotUsageDay, SyncResult } from "../../types.js";

function formatDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

export async function runSyncCycle(
  config: CopilotConfig,
  fromOverride?: string,
  toOverride?: string,
  dryRun = false,
): Promise<{ result: SyncResult; dryRunPayloads?: object[] }> {
  const state = await loadState();
  const now = Date.now();

  const overlapMs = DEFAULT_OVERLAP_DAYS * 24 * 60 * 60 * 1000;

  let since: string;
  if (fromOverride) {
    since = fromOverride;
  } else if (state.lastSyncTimestamp > 0) {
    since = formatDate(state.lastSyncTimestamp - overlapMs);
  } else {
    since = formatDate(now - 28 * 24 * 60 * 60 * 1000);
  }

  const until = toOverride ?? formatDate(now);

  const deduplicator = new Deduplicator(state.recentHashes);
  const result: SyncResult = {
    fetched: 0,
    sent: 0,
    duplicatesSkipped: 0,
    errors: 0,
  };

  let pendingDays: CopilotUsageDay[] = [];
  let pendingRecordCount = 0;
  let highWatermark = state.lastSyncTimestamp;
  const dryRunPayloads: object[] = [];

  try {
    for await (const batch of fetchUsageDays(config.githubToken, config.githubOrg, since, until)) {
      for (const day of batch) {
        if (!isValidDay(day.day)) continue;

        const uniqueBreakdowns = [];

        for (const breakdown of day.breakdown) {
          const hash = computeBreakdownHash(day, breakdown);
          result.fetched++;

          if (deduplicator.isDuplicate(hash)) {
            result.duplicatesSkipped++;
            continue;
          }

          deduplicator.mark(hash);
          uniqueBreakdowns.push(breakdown);
        }

        if (uniqueBreakdowns.length > 0) {
          pendingDays.push({ ...day, breakdown: uniqueBreakdowns });
          pendingRecordCount += uniqueBreakdowns.length;

          const dayTimestamp = new Date(day.day).getTime();
          if (dayTimestamp > highWatermark) {
            highWatermark = dayTimestamp;
          }
        }

        if (pendingRecordCount >= MAX_EVENTS_PER_BATCH) {
          const sent = await sendBatch(pendingDays, config, dryRun, dryRunPayloads);
          result.sent += sent;
          if (sent < pendingRecordCount && !dryRun) {
            result.errors += pendingRecordCount - sent;
          }
          pendingDays = [];
          pendingRecordCount = 0;
        }
      }
    }

    if (pendingDays.length > 0) {
      const sent = await sendBatch(pendingDays, config, dryRun, dryRunPayloads);
      result.sent += sent;
      if (sent < pendingRecordCount && !dryRun) {
        result.errors += pendingRecordCount - sent;
      }
    }

    if (!dryRun) {
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

  return { result, dryRunPayloads: dryRun ? dryRunPayloads : undefined };
}

async function sendBatch(
  days: CopilotUsageDay[],
  config: CopilotConfig,
  dryRun: boolean,
  dryRunPayloads: object[],
): Promise<number> {
  if (days.length === 0) return 0;

  const payload = buildOtlpPayload(days, config);
  const recordCount = days.reduce((sum, d) => sum + d.breakdown.length, 0);

  if (dryRun) {
    dryRunPayloads.push(payload);
    return recordCount;
  }

  try {
    await sendOtlpTraces(config.reveniumEndpoint, config.reveniumApiKey, payload);
    return recordCount;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[copilot] Dropped ${recordCount} event(s) after retry exhaustion: ${msg}`);
    return 0;
  }
}

export class SyncWatcher {
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private resolveWait: (() => void) | null = null;

  constructor(private config: CopilotConfig) {}

  async start(
    onCycle?: (result: SyncResult) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    this.running = true;
    await startupStagger();

    while (this.running) {
      try {
        const { result } = await runSyncCycle(this.config);
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
