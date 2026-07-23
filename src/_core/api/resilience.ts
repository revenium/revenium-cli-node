export function parsePositiveInt(envVar: string, fallback: number): number {
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

export const DEFAULT_TARGET_TPS = 25;

export function getTargetTps(): number {
  return parsePositiveFloat("REVENIUM_TARGET_TPS", DEFAULT_TARGET_TPS);
}

export function getStartupStaggerMs(): number {
  return parseNonNegativeInt("REVENIUM_STARTUP_STAGGER_MS", 5000);
}

export function getBackoffMaxMs(): number {
  return parsePositiveInt("REVENIUM_BACKOFF_MAX_MS", 60_000);
}

export function jitteredBackoff(attempt: number, baseMs?: number): number {
  const base = baseMs ?? getBackoffBaseMs();
  const maxMs = getBackoffMaxMs();
  return Math.min(base * Math.pow(2, attempt) * Math.random(), maxMs);
}

export async function startupStagger(maxMs?: number): Promise<void> {
  const max = maxMs ?? getStartupStaggerMs();
  const delay = Math.random() * max;
  if (delay > 0) {
    await sleep(delay);
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableStatusCode(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function isNonRetryable4xx(status: number): boolean {
  return status >= 400 && status < 500 && !isRetryableStatusCode(status);
}

export function isRetryableNetworkError(error: Error): boolean {
  return (
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  );
}

export function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return null;
}

export function sanitizeErrorMessage(message: string, secret: string): string {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escaped, "g"), "***");
}
