import { CURSOR_API_BASE_URL, MAX_DAYS_PER_REQUEST } from "../constants.js";
import type { CursorUsageEvent, CursorPaginatedResponse } from "../types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

function buildAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${encoded}`;
}

function isRetryableStatusCode(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryableError(error: Error): boolean {
  return (
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  const escapedKey = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedKey, "g"), "***");
}

async function cursorRequest<T>(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${CURSOR_API_BASE_URL}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

      if (!response.ok) {
        const errorText = await response.text();
        const sanitized = sanitizeErrorMessage(errorText, apiKey);

        if (isRetryableStatusCode(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(
            `Cursor API ${response.status} ${response.statusText} - ${sanitized}`,
          );
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }

        throw new Error(`Cursor API ${response.status} ${response.statusText} - ${sanitized}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Cursor API request timeout after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
          lastError = new Error(sanitizeErrorMessage(error.message, apiKey));
        }

        if (isRetryableError(lastError) && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
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
        ? new Date(event.timestamp as unknown as string).getTime()
        : event.timestamp,
  }));
}

async function fetchPage(
  apiKey: string,
  from: number,
  to: number,
  page?: number,
): Promise<CursorPaginatedResponse> {
  const body: Record<string, unknown> = {
    startDate: from,
    endDate: to,
    pageSize: 100,
  };

  if (page !== undefined) {
    body.page = page;
  }

  return cursorRequest<CursorPaginatedResponse>("/teams/filtered-usage-events", apiKey, body);
}

export async function* fetchEvents(
  apiKey: string,
  from: number,
  to: number,
): AsyncGenerator<CursorUsageEvent[]> {
  const msPerChunk = MAX_DAYS_PER_REQUEST * 24 * 60 * 60 * 1000;
  let chunkStart = from;

  while (chunkStart < to) {
    const chunkEnd = Math.min(chunkStart + msPerChunk, to);
    let page = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetchPage(apiKey, chunkStart, chunkEnd, page);
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
    await fetchPage(apiKey, oneHourAgo, now);
    return true;
  } catch {
    return false;
  }
}
