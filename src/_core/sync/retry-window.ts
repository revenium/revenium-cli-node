export interface RetryWindowInput {
  requestedWindowStart: number;
  lastSyncTimestamp: number;
  overlapMs: number;
  retentionFloor: number;
}

export function computeHeldWatermark({
  requestedWindowStart,
  lastSyncTimestamp,
  overlapMs,
  retentionFloor,
}: RetryWindowInput): number {
  const defaultWindowStart =
    lastSyncTimestamp > 0 ? lastSyncTimestamp - overlapMs : requestedWindowStart;
  const heldWindowStart = Math.max(
    Math.min(requestedWindowStart, defaultWindowStart),
    retentionFloor,
  );

  return heldWindowStart + overlapMs;
}
