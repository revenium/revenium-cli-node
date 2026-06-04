import type { OTLPLogsPayload, OTLPTracesPayload, OTLPResponse } from "../types/index.js";
import { getFullOtlpEndpoint } from "../config/loader.js";
import { jitteredBackoff, getMaxRetries, getRequestTimeoutMs } from "./resilience.js";

function isRetryableError(error: Error): boolean {
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  const escapedKey = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedKey, "g"), "***");
}

export async function sendOtlpLogs(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
): Promise<OTLPResponse> {
  const fullEndpoint = getFullOtlpEndpoint(baseEndpoint);
  const url = `${fullEndpoint}/v1/logs`;

  let lastError: Error | null = null;

  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();

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

      if (!response.ok) {
        const errorText = await response.text();
        clearTimeout(timeoutId);
        const sanitizedError = sanitizeErrorMessage(errorText, apiKey);

        if (isRetryableStatusCode(response.status) && attempt < maxRetries - 1) {
          lastError = new Error(
            `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`,
          );
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw new Error(
          `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`,
        );
      }

      const result = await response.json();
      clearTimeout(timeoutId);
      return result as OTLPResponse;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
        } else {
          lastError = new Error(sanitizeErrorMessage(error.message, apiKey));
        }

        if (isRetryableError(lastError) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw lastError;
      }
      throw error;
    }
  }

  throw lastError || new Error("Request failed after retries");
}

export async function sendOtlpTraces(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPTracesPayload,
): Promise<OTLPResponse> {
  const fullEndpoint = getFullOtlpEndpoint(baseEndpoint);
  const url = `${fullEndpoint}/v1/traces`;

  let lastError: Error | null = null;

  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();

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

      if (!response.ok) {
        const errorText = await response.text();
        clearTimeout(timeoutId);
        const sanitizedError = sanitizeErrorMessage(errorText, apiKey);

        if (isRetryableStatusCode(response.status) && attempt < maxRetries - 1) {
          lastError = new Error(
            `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`,
          );
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw new Error(
          `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`,
        );
      }

      const result = await response.json();
      clearTimeout(timeoutId);
      return result as OTLPResponse;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
        } else {
          lastError = new Error(sanitizeErrorMessage(error.message, apiKey));
        }

        if (isRetryableError(lastError) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }

        throw lastError;
      }
      throw error;
    }
  }

  throw lastError || new Error("Request failed after retries");
}
