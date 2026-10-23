import { CURSOR_API_BASE_URL, MAX_DAYS_PER_REQUEST } from "../constants.js";
import type { CursorUsageEvent, CursorPaginatedResponse } from "../types.js";
import {
  jitteredBackoff,
  getMaxRetries,
  getRequestTimeoutMs,
  parsePositiveInt,
  sleep,
  isRetryableStatusCode,
  isNonRetryable4xx,
  retryDelayMs,
  sanitizeErrorMessage,
} from "../../_core/api/resilience.js";
import {
  describeTransportFailure,
  isRetryableTransportError,
} from "../../_core/api/network-error.js";

export const DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS = 7_500;

export const CURSOR_MAX_PAGE_SIZE = 1_000;

const CONNECTIVITY_PROBE_PAGE_SIZE = 100;
const INTEGER_PATTERN = /^\d+$/;

export function getCursorMinRequestIntervalMs(): number {
  return parsePositiveInt("CURSOR_MIN_REQUEST_INTERVAL_MS", DEFAULT_CURSOR_MIN_REQUEST_INTERVAL_MS);
}

export function getCursorPageSize(): number {
  const raw = process.env.CURSOR_PAGE_SIZE;
  if (raw === undefined || raw === "") return CURSOR_MAX_PAGE_SIZE;

  const trimmed = raw.trim();
  const parsed = INTEGER_PATTERN.test(trimmed) ? Number(trimmed) : NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    console.warn(
      `[cursor] CURSOR_PAGE_SIZE="${raw}" is not a positive whole number of events; using ${CURSOR_MAX_PAGE_SIZE}`,
    );
    return CURSOR_MAX_PAGE_SIZE;
  }

  return Math.min(parsed, CURSOR_MAX_PAGE_SIZE);
}

export class CursorWindowTruncatedError extends Error {
  constructor(readonly truncatedWindows: number) {
    super(
      `Cursor returned an empty page while reporting more pages in ${truncatedWindows} time window(s); those windows were read only in part, so events older than the ones already read were not fetched. Re-run this range to pick them up.`,
    );
    this.name = "CursorWindowTruncatedError";
  }
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
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (pacer) {
      await pace(pacer);
    }

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
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      throw lastError;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof NonRetryableHttpError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error !== lastError) {
          lastError = new Error(describeTransportFailure(error, apiKey, timeoutMs, "Cursor API"));
        }

        if (isRetryableTransportError(error) && attempt < maxRetries - 1) {
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function normalizeNumericFields(events: CursorUsageEvent[]): CursorUsageEvent[] {
  return events.map((event) => ({
    ...event,
    timestamp: toFiniteNumber(event.timestamp) ?? NaN,
    chargedCents: toFiniteNumber(event.chargedCents),
  }));
}

interface PageRequest {
  from: number;
  to: number;
  pageSize: number;
  page: number;
}

async function fetchPage(
  apiKey: string,
  request: PageRequest,
  pacer?: FetchPacer,
): Promise<CursorPaginatedResponse> {
  return cursorRequest<CursorPaginatedResponse>(
    "/teams/filtered-usage-events",
    apiKey,
    {
      startDate: request.from,
      endDate: request.to,
      pageSize: request.pageSize,
      page: request.page,
    },
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
  const pageSize = getCursorPageSize();
  const msPerChunk = MAX_DAYS_PER_REQUEST * 24 * 60 * 60 * 1000;
  let chunkStart = from;
  let truncatedWindows = 0;

  while (chunkStart < to) {
    const chunkEnd = Math.min(chunkStart + msPerChunk, to);
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetchPage(
        apiKey,
        { from: chunkStart, to: chunkEnd, pageSize, page },
        pacer,
      );
      const events = normalizeNumericFields(response.usageEvents);

      if (events.length > 0) {
        yield events;
      }

      if (response.pagination.hasNextPage && events.length === 0) {
        truncatedWindows++;
        console.warn(
          `[cursor] Cursor returned an empty page ${page} of ${response.pagination.numPages} while reporting more pages; stopping this window early, events older than the ones already read may be missing`,
        );
      }

      hasNextPage = response.pagination.hasNextPage && events.length > 0;
      page++;
    }

    chunkStart = chunkEnd;
  }

  if (truncatedWindows > 0) {
    throw new CursorWindowTruncatedError(truncatedWindows);
  }
}

export async function testConnectivity(apiKey: string): Promise<boolean> {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  try {
    await fetchPage(apiKey, {
      from: oneHourAgo,
      to: now,
      pageSize: CONNECTIVITY_PROBE_PAGE_SIZE,
      page: 1,
    });
    return true;
  } catch {
    return false;
  }
}
