import type { OTLPLogsPayload, OTLPTracesPayload, OTLPResponse } from "../types/index.js";
import { getFullOtlpEndpoint } from "../config/loader.js";
import {
  jitteredBackoff,
  getMaxRetries,
  getRequestTimeoutMs,
  getBackoffMaxMs,
} from "./resilience.js";

export interface OtlpSendResult {
  success: boolean;
  error?: string;
}

function isRetryableNetworkError(error: Error): boolean {
  return (
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  );
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

function isNonRetryable4xx(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function parseRetryAfterMs(response: Response): number | null {
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  const escapedKey = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedKey, "g"), "***");
}

async function sendOtlpRequest(
  url: string,
  apiKey: string,
  payload: OTLPLogsPayload | OTLPTracesPayload,
): Promise<OTLPResponse> {
  let lastError: Error | null = null;
  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();
  const backoffMaxMs = getBackoffMaxMs();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        const result = (await response.json()) as OTLPResponse;
        clearTimeout(timeoutId);
        return result;
      }

      const errorText = await response.text();
      clearTimeout(timeoutId);
      const sanitizedError = sanitizeErrorMessage(errorText, apiKey);
      const errorMsg = `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`;

      if (isNonRetryable4xx(response.status)) {
        throw new Error(errorMsg);
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
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
        } else if (lastError?.message !== error.message) {
          lastError = new Error(sanitizeErrorMessage(error.message, apiKey));
        }

        if (isRetryableNetworkError(lastError!) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw lastError!;
      }
      throw error;
    }
  }

  throw lastError || new Error("Request failed after retries");
}

export async function sendOtlpLogs(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
): Promise<OTLPResponse> {
  const url = `${getFullOtlpEndpoint(baseEndpoint)}/v1/logs`;
  return sendOtlpRequest(url, apiKey, payload);
}

export async function sendOtlpTraces(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPTracesPayload,
): Promise<OTLPResponse> {
  const url = `${getFullOtlpEndpoint(baseEndpoint)}/v1/traces`;
  return sendOtlpRequest(url, apiKey, payload);
}

export async function sendLogsWithResult(
  endpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
): Promise<OtlpSendResult> {
  try {
    await sendOtlpLogs(endpoint, apiKey, payload);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: errorMsg };
  }
}

export async function sendTracesWithResult(
  endpoint: string,
  apiKey: string,
  payload: OTLPTracesPayload,
): Promise<OtlpSendResult> {
  try {
    await sendOtlpTraces(endpoint, apiKey, payload);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: errorMsg };
  }
}
