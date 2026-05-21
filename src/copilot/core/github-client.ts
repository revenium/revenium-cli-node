import { GITHUB_API_BASE_URL, MAX_DAYS_PER_REQUEST } from "../constants.js";
import type { CopilotUsageDay } from "../types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

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

function sanitizeErrorMessage(message: string, token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedToken, "g"), "***");
}

function parseRetryAfter(header: string | null, attempt: number): number {
  const fallback = RETRY_DELAY_MS * (attempt + 1);
  if (!header) return fallback;

  const seconds = parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.max(date.getTime() - Date.now(), 0);
  }

  return fallback;
}

function parseNextPageUrl(linkHeader: string): string | null {
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function formatDateParam(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function githubRequest<T>(
  url: string,
  token: string,
): Promise<{ data: T; nextUrl: string | null }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        const sanitized = sanitizeErrorMessage(errorText, token);

        if (isRetryableStatusCode(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(
            `GitHub API ${response.status} ${response.statusText} - ${sanitized}`,
          );

          if (response.status === 429) {
            await sleep(parseRetryAfter(response.headers.get("retry-after"), attempt));
          } else {
            await sleep(RETRY_DELAY_MS * (attempt + 1));
          }
          continue;
        }

        throw new Error(`GitHub API ${response.status} ${response.statusText} - ${sanitized}`);
      }

      const data = (await response.json()) as T;
      const linkHeader = response.headers.get("link");
      const nextUrl = linkHeader ? parseNextPageUrl(linkHeader) : null;

      return { data, nextUrl };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`GitHub API request timeout after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
          lastError = new Error(sanitizeErrorMessage(error.message, token));
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

  throw lastError || new Error("GitHub API request failed after retries");
}

export async function* fetchUsageDays(
  token: string,
  org: string,
  since?: string,
  until?: string,
): AsyncGenerator<CopilotUsageDay[]> {
  const now = new Date();
  const defaultSince = new Date(now);
  defaultSince.setDate(defaultSince.getDate() - MAX_DAYS_PER_REQUEST);

  const sinceDate = since ? new Date(since) : defaultSince;
  const untilDate = until ? new Date(until) : now;

  const msPerChunk = MAX_DAYS_PER_REQUEST * 24 * 60 * 60 * 1000;
  let chunkStart = new Date(sinceDate);

  while (chunkStart < untilDate) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + msPerChunk, untilDate.getTime()));

    const params = new URLSearchParams({
      since: formatDateParam(chunkStart),
      until: formatDateParam(chunkEnd),
    });

    let url: string | null =
      `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/copilot/usage?${params.toString()}`;

    while (url) {
      const result: { data: CopilotUsageDay[]; nextUrl: string | null } = await githubRequest<
        CopilotUsageDay[]
      >(url, token);

      if (result.data.length > 0) {
        yield result.data;
      }

      url = result.nextUrl;
    }

    chunkStart = chunkEnd;
  }
}

export async function testConnectivity(token: string, org: string): Promise<boolean> {
  const now = new Date();
  const oneDayAgo = new Date(now);
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const params = new URLSearchParams({
    since: formatDateParam(oneDayAgo),
    until: formatDateParam(now),
  });

  const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/copilot/usage?${params.toString()}`;

  try {
    await githubRequest<CopilotUsageDay[]>(url, token);
    return true;
  } catch {
    return false;
  }
}
