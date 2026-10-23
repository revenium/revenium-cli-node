import { describeTransportFailure } from "./network-error.js";

const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Lightweight API key verification via the Revenium resolve-key endpoint.
 * Returns false when the endpoint answers and rejects the key, and throws when
 * the endpoint cannot be reached.
 */
export async function verifyApiKey(endpoint: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const url = `${endpoint.replace(/\/+$/, "")}/v2/sdk/resolve-key`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });

    return response.status === 200;
  } catch (error) {
    throw error instanceof Error
      ? new Error(describeTransportFailure(error, apiKey, VERIFY_TIMEOUT_MS))
      : error;
  } finally {
    clearTimeout(timeout);
  }
}
