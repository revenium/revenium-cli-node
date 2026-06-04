import chalk from "chalk";
import { sendOtlpLogs, sendOtlpTraces } from "./otlp-client.js";
import { jitteredBackoff, getBackoffBaseMs, getMaxRetries } from "./resilience.js";
import type { OTLPLogsPayload, OTLPTracesPayload } from "../types/index.js";

export const MAX_RETRIES = getMaxRetries();

export interface RetryResult {
  success: boolean;
  attempts: number;
  error?: string;
}

export function isRetryableError(errorMsg: string): boolean {
  const statusMatch = errorMsg.match(/OTLP request failed: (\d{3})/);
  if (!statusMatch) return true;

  const statusCode = parseInt(statusMatch[1], 10);
  if (statusCode === 429) return true;
  if (statusCode >= 400 && statusCode < 500) return false;
  return true;
}

export async function sendBatchWithRetry(
  endpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
  maxRetries: number = MAX_RETRIES,
  verbose: boolean = false,
): Promise<RetryResult> {
  if (maxRetries <= 0) return { success: false, attempts: 0, error: "No retries configured" };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sendOtlpLogs(endpoint, apiKey, payload);
      return { success: true, attempts: attempt + 1 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      if (!isRetryableError(errorMsg)) {
        if (verbose) {
          console.log(chalk.red(`  Non-retryable error: ${errorMsg}`));
        }
        return { success: false, attempts: attempt + 1, error: errorMsg };
      }

      if (verbose) {
        console.log(chalk.yellow(`  Attempt ${attempt + 1} failed: ${errorMsg}`));
      }

      if (attempt < maxRetries - 1) {
        const backoffDelay = jitteredBackoff(attempt, getBackoffBaseMs());
        if (verbose) {
          console.log(chalk.yellow(`  Retrying in ${Math.round(backoffDelay)}ms...`));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, backoffDelay));
      } else {
        return { success: false, attempts: maxRetries, error: errorMsg };
      }
    }
  }

  return { success: false, attempts: maxRetries };
}

export async function sendTraceBatchWithRetry(
  endpoint: string,
  apiKey: string,
  payload: OTLPTracesPayload,
  maxRetries: number = MAX_RETRIES,
  verbose: boolean = false,
): Promise<RetryResult> {
  if (maxRetries <= 0) return { success: false, attempts: 0, error: "No retries configured" };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sendOtlpTraces(endpoint, apiKey, payload);
      return { success: true, attempts: attempt + 1 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      if (!isRetryableError(errorMsg)) {
        if (verbose) {
          console.log(chalk.red(`  Non-retryable error: ${errorMsg}`));
        }
        return { success: false, attempts: attempt + 1, error: errorMsg };
      }

      if (verbose) {
        console.log(chalk.yellow(`  Attempt ${attempt + 1} failed: ${errorMsg}`));
      }

      if (attempt < maxRetries - 1) {
        const backoffDelay = jitteredBackoff(attempt, getBackoffBaseMs());
        if (verbose) {
          console.log(chalk.yellow(`  Retrying in ${Math.round(backoffDelay)}ms...`));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, backoffDelay));
      } else {
        return { success: false, attempts: maxRetries, error: errorMsg };
      }
    }
  }

  return { success: false, attempts: maxRetries };
}
