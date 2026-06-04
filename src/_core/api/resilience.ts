function parsePositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveFloat(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMaxRetries(): number {
  return parsePositiveInt("REVENIUM_MAX_RETRIES", 3);
}

export function getRequestTimeoutMs(): number {
  return parsePositiveInt("REVENIUM_REQUEST_TIMEOUT_MS", 30_000);
}

export function getBackoffBaseMs(): number {
  return parsePositiveInt("REVENIUM_BACKOFF_BASE_MS", 1000);
}

export function getTargetTps(): number {
  return parsePositiveFloat("REVENIUM_TARGET_TPS", 5);
}

export function getStartupStaggerMs(): number {
  return parseNonNegativeInt("REVENIUM_STARTUP_STAGGER_MS", 5000);
}

export function jitteredBackoff(attempt: number, baseMs?: number): number {
  const base = baseMs ?? getBackoffBaseMs();
  return base * Math.pow(2, attempt) * Math.random();
}

export async function startupStagger(maxMs?: number): Promise<void> {
  const max = maxMs ?? getStartupStaggerMs();
  const delay = Math.random() * max;
  if (delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
