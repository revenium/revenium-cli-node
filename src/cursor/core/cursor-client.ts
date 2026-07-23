import { CURSOR_API_BASE_URL, MAX_DAYS_PER_REQUEST } from "../constants.js";
import type { CursorUsageEvent, CursorPaginatedResponse } from "../types.js";
import {
  jitteredBackoff,
  getMaxRetries,
  getRequestTimeoutMs,
  getBackoffMaxMs,
  parsePositiveInt,
  sleep,
  isRetryableStatusCode,
  isNonRetryable4xx,
  isRetryableNetworkError,
  parseRetryAfterMs,
  sanitizeErrorMessage,
} from "../../_core/api/resilience.js";

export const DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS = 7_500;

export function getCursorMinRequestIntervalMs(): number {
  return parsePositiveInt("CURSOR_MIN_REQUEST_INTERVAL_MS", DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS);
}

export interface FetchPacer {
  nextAvailableTimeMs: number;
  minIntervalMs: number;
}

export function createFetchPacer(minIntervalMs?: number): FetchPacer {
  const interval =
    minIntervalMs !== undefined && Number.isFinite(minIntervalMs) && minIntervalMs >= 0
      ? minIntervalMs
      : getCursorMinRequestIntervalMs();
  return { nextAvailableTimeMs: Date.now(), minIntervalMs: interval };
}

async function pace(pacer: FetchPacer): Promise<void> {
  if (pacer.minIntervalMs <= 0) return;

  const now = Date.now();
  const waitMs = Math.max(0, pacer.nextAvailableTimeMs - now);
  pacer.nextAvailableTimeMs = Math.max(now, pacer.nextAvailableTimeMs) + pacer.minIntervalMs;

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function buildAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${encoded}`;
}

class NonRetryableHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableHttpError";
  }
}

async function cursorRequest<T>(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
  pacer?: FetchPacer,
): Promise<T> {
  const url = `${CURSOR_API_BASE_URL}${path}`;
  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();
  const backoffMaxMs = getBackoffMaxMs();
  let lastError: Error | null = null;

  if (pacer) {
    await pace(pacer);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: buildAuthHeader(apiKey),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const result = (await response.json()) as T;
        return result;
      }

      const errorText = await response.text();
      const sanitized = sanitizeErrorMessage(errorText, apiKey);
      const errorMsg = `Cursor API ${response.status} ${response.statusText} - ${sanitized}`;

      if (isNonRetryable4xx(response.status)) {
        throw new NonRetryableHttpError(errorMsg);
      }

      lastError = new Error(errorMsg);

      if (isRetryableStatusCode(response.status) && attempt < maxRetries - 1) {
        const backoff = jitteredBackoff(attempt);
        const retryAfterMs = parseRetryAfterMs(response);
        const cappedRetryAfter =
          retryAfterMs !== null ? Math.min(retryAfterMs, backoffMaxMs) : null;
        const delay = cappedRetryAfter !== null ? Math.max(cappedRetryAfter, backoff) : backoff;
        await sleep(delay);
        continue;
      }

      throw lastError;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof NonRetryableHttpError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Cursor API request timeout after ${timeoutMs}ms`);
        } else if (lastError?.message !== error.message) {
          lastError = new Error(sanitizeErrorMessage(error.message, apiKey));
        }

        if (isRetryableNetworkError(lastError) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw lastError;
      }
      throw error;
    }
  }

  throw lastError || new Error("Cursor API request failed after retries");
}

function parseTimestamps(events: CursorUsageEvent[]): CursorUsageEvent[] {
  return events.map((event) => ({
    ...event,
    timestamp:
      typeof event.timestamp === "string"
        ? Number(event.timestamp as unknown as string)
        : event.timestamp,
  }));
}

async function fetchPage(
  apiKey: string,
  from: number,
  to: number,
  page?: number,
  pacer?: FetchPacer,
): Promise<CursorPaginatedResponse> {
  const body: Record<string, unknown> = {
    startDate: from,
    endDate: to,
    pageSize: 100,
  };

  if (page !== undefined) {
    body.page = page;
  }

  return cursorRequest<CursorPaginatedResponse>(
    "/teams/filtered-usage-events",
    apiKey,
    body,
    pacer,
  );
}

export interface FetchEventsOptions {
  minRequestIntervalMs?: number;
}

export async function* fetchEvents(
  apiKey: string,
  from: number,
  to: number,
  options: FetchEventsOptions = {},
): AsyncGenerator<CursorUsageEvent[]> {
  const pacer = createFetchPacer(options.minRequestIntervalMs);
  const msPerChunk = MAX_DAYS_PER_REQUEST * 24 * 60 * 60 * 1000;
  let chunkStart = from;

  while (chunkStart < to) {
    const chunkEnd = Math.min(chunkStart + msPerChunk, to);
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetchPage(apiKey, chunkStart, chunkEnd, page, pacer);
      const events = parseTimestamps(response.usageEvents);

      if (events.length > 0) {
        yield events;
      }

      hasNextPage = response.pagination.hasNextPage;
      page++;
    }

    chunkStart = chunkEnd;
  }
}

export async function testConnectivity(apiKey: string): Promise<boolean> {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  try {
    await fetchPage(apiKey, oneHourAgo, now, 1);
    return true;
  } catch {
    return false;
  }
}
