import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyApiKey } from "../../../src/_core/api/verify-key.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchStatus(status: number) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
  });
}

function mockFetchReject(error: Error) {
  (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(error);
}

describe("verifyApiKey", () => {
  it("returns true on 200 response", async () => {
    mockFetchStatus(200);
    const result = await verifyApiKey("https://api.revenium.ai", "hak_test_key");
    expect(result).toBe(true);
  });

  it("returns false on 401 response", async () => {
    mockFetchStatus(401);
    const result = await verifyApiKey("https://api.revenium.ai", "hak_bad_key");
    expect(result).toBe(false);
  });

  it("throws the underlying cause instead of reporting an invalid key", async () => {
    mockFetchReject(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "self signed certificate" },
      }),
    );

    await expect(verifyApiKey("https://api.revenium.ai", "hak_test_key")).rejects.toThrow(
      /DEPTH_ZERO_SELF_SIGNED_CERT/,
    );
  });

  it("throws on timeout (AbortError)", async () => {
    mockFetchReject(new DOMException("The operation was aborted.", "AbortError"));
    await expect(verifyApiKey("https://api.revenium.ai", "hak_test_key")).rejects.toThrow(
      /Request timeout after 10000ms[\s\S]*never answered/,
    );
  });

  it("does not leak the API key carried in the cause", async () => {
    const apiKey = "hak_tenant_abc123xyz";
    mockFetchReject(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND for key ${apiKey}` },
      }),
    );

    await expect(verifyApiKey("https://api.revenium.ai", apiKey)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(apiKey) }),
    );
  });

  it("correctly constructs URL from endpoint (strips trailing slashes)", async () => {
    mockFetchStatus(200);
    await verifyApiKey("https://api.revenium.ai///", "hak_test_key");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/sdk/resolve-key",
      expect.anything(),
    );
  });

  it("correctly constructs URL from endpoint without trailing slash", async () => {
    mockFetchStatus(200);
    await verifyApiKey("https://api.revenium.ai", "hak_test_key");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/sdk/resolve-key",
      expect.anything(),
    );
  });

  it("sends x-api-key header", async () => {
    mockFetchStatus(200);
    const apiKey = "hak_tenant_abc123xyz";
    await verifyApiKey("https://api.revenium.ai", apiKey);
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers["x-api-key"]).toBe(apiKey);
  });
});
