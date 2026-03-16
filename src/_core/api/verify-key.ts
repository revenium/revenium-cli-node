/**
 * Lightweight API key verification via the Revenium resolve-key endpoint.
 */
export async function verifyApiKey(endpoint: string, apiKey: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const url = `${endpoint.replace(/\/+$/, "")}/v2/sdk/resolve-key`;
      const response = await fetch(url, {
        method: "GET",
        headers: { "x-api-key": apiKey },
        signal: controller.signal,
      });

      return response.status === 200;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}
