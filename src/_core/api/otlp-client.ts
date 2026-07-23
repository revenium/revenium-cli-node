import type { OTLPLogsPayload, OTLPTracesPayload, OTLPResponse } from "../types/index.js";
import { getFullOtlpEndpoint } from "../config/loader.js";
import {
  jitteredBackoff,
  getMaxRetries,
  getRequestTimeoutMs,
  getBackoffMaxMs,
  sleep,
  isRetryableStatusCode,
  isNonRetryable4xx,
  isRetryableNetworkError,
  parseRetryAfterMs,
  sanitizeErrorMessage,
} from "./resilience.js";
import { createRateLimiterState, enforceRateLimit } from "./rate-limiter.js";
import type { RateLimiterState } from "./rate-limiter.js";

export interface OtlpSendResult {
  success: boolean;
  error?: string;
}

export interface OtlpSendOptions {
  batchSize?: number;
  userDelayMs?: number;
}

let globalRateLimiterState: RateLimiterState | null = null;

function getGlobalRateLimiterState(): RateLimiterState {
  if (!globalRateLimiterState) {
    globalRateLimiterState = createRateLimiterState();
  }
  return globalRateLimiterState;
}

async function sendOtlpRequest(
  url: string,
  apiKey: string,
  payload: OTLPLogsPayload | OTLPTracesPayload,
  options?: OtlpSendOptions,
): Promise<OTLPResponse> {
  const state = getGlobalRateLimiterState();
  await enforceRateLimit(state, {
    batchSize: options?.batchSize ?? 1,
    userDelayMs: options?.userDelayMs,
  });

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
  options?: OtlpSendOptions,
): Promise<OTLPResponse> {
  const url = `${getFullOtlpEndpoint(baseEndpoint)}/v1/logs`;
  return sendOtlpRequest(url, apiKey, payload, options);
}

export async function sendOtlpTraces(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPTracesPayload,
  options?: OtlpSendOptions,
): Promise<OTLPResponse> {
  const url = `${getFullOtlpEndpoint(baseEndpoint)}/v1/traces`;
  return sendOtlpRequest(url, apiKey, payload, options);
}

export async function sendLogsWithResult(
  endpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
  options?: OtlpSendOptions,
): Promise<OtlpSendResult> {
  try {
    await sendOtlpLogs(endpoint, apiKey, payload, options);
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
  options?: OtlpSendOptions,
): Promise<OtlpSendResult> {
  try {
    await sendOtlpTraces(endpoint, apiKey, payload, options);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: errorMsg };
  }
}
