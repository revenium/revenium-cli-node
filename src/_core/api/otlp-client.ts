import type { OTLPLogsPayload, OTLPResponse } from "../types/index.js";
import { getFullOtlpEndpoint } from "../config/loader.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

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

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

        if (isRetryableStatusCode(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(
            `OTLP request failed: ${response.status} ${response.statusText} - ${sanitizedError}`,
          );
          await sleep(RETRY_DELAY_MS * (attempt + 1));
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
          lastError = new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
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

  throw lastError || new Error("Request failed after retries");
}
