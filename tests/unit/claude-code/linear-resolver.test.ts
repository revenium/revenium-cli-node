import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(() => Promise.resolve("LINEAR_API_KEY=lin_api_test")),
}));

import { resolveLinearTitle } from "../../../src/claude-code/ticket/linear-resolver.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveLinearTitle", () => {
  it("keeps the timeout active while parsing a stalled response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted", "AbortError")),
              );
            }),
        });
      }),
    );

    const resolution = resolveLinearTitle("PRODUCT-1234");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resolution).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    const options = vi.mocked(fetch).mock.calls[0][1];
    expect(options?.signal?.aborted).toBe(true);
  });
});
