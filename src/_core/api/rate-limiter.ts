export const DEFAULT_TARGET_TPS = 5;
export const MAX_BATCH_SIZE = 100;
export const DEFAULT_BATCH_SIZE = 10;

export interface RateLimiterState {
  nextAvailableTimeMs: number;
}

export interface RateLimitOptions {
  batchSize: number;
  targetTps?: number;
  userDelayMs?: number;
}

export function createRateLimiterState(): RateLimiterState {
  return { nextAvailableTimeMs: Date.now() };
}

export async function enforceRateLimit(
  state: RateLimiterState,
  options: RateLimitOptions,
): Promise<void> {
  const { batchSize, targetTps = DEFAULT_TARGET_TPS, userDelayMs: rawUserDelay = 0 } = options;

  if (!Number.isFinite(batchSize) || batchSize <= 0) return;
  if (!Number.isFinite(targetTps) || targetTps <= 0) return;

  const userDelayMs = Number.isFinite(rawUserDelay) && rawUserDelay > 0 ? rawUserDelay : 0;

  const now = Date.now();

  const requiredIntervalMs = (batchSize / targetTps) * 1000;
  const earliestNextTime = Math.max(state.nextAvailableTimeMs, now);
  const calculatedDelay = earliestNextTime - now;
  const finalDelay = Math.max(calculatedDelay, userDelayMs);

  state.nextAvailableTimeMs = now + finalDelay + requiredIntervalMs;

  if (finalDelay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, finalDelay));
  }
}
