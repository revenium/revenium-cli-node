import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  postAssociation,
  sanitizeRepoUrl,
} from "../../../src/claude-code/ticket/association-client.js";
import type { AssociationRequest } from "../../../src/claude-code/ticket/association-client.js";

const BASE_URL = "https://api.revenium.ai";
const API_KEY = "hak_test123";

const validReq: AssociationRequest = {
  sessionId: "sess-abc-123",
  ticketId: "PRODUCT-1234",
  ticketTitle: "Fix the thing",
  source: "claude-code",
  teamId: "teamHash123",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown = {}) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchNetworkError(message = "Network error") {
  (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(message));
}

describe("postAssociation — success cases", () => {
  it("returns ok:true, degraded:false on 201", async () => {
    mockFetch(201);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result).toEqual({ ok: true, degraded: false });
  });

  it("returns ok:true, degraded:false on 200", async () => {
    mockFetch(200);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result).toEqual({ ok: true, degraded: false });
  });

  it("sends to the synchronous management-plane endpoint", async () => {
    mockFetch(200);
    await postAssociation(BASE_URL, API_KEY, validReq);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/api/sessions/sess-abc-123/attribution?teamId=teamHash123",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends x-api-key header", async () => {
    mockFetch(201);
    await postAssociation(BASE_URL, API_KEY, validReq);
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers["x-api-key"]).toBe(API_KEY);
  });

  it("serialises the request body correctly", async () => {
    mockFetch(201);
    await postAssociation(BASE_URL, API_KEY, validReq);
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(opts.body as string);
    expect(body).not.toHaveProperty("sessionId");
    expect(body.ticketId).toBe("PRODUCT-1234");
    expect(body.source).toBe("claude-code");
    expect(body).not.toHaveProperty("effectiveFrom");
  });

  it("strips trailing slash from baseEndpoint", async () => {
    mockFetch(201);
    await postAssociation("https://api.revenium.ai/", API_KEY, validReq);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/api/sessions/sess-abc-123/attribution?teamId=teamHash123",
      expect.anything(),
    );
  });

  it("omits teamId when the backend derives the organization from the metering key", async () => {
    mockFetch(200);
    await postAssociation(BASE_URL, API_KEY, { ...validReq, teamId: undefined });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/api/sessions/sess-abc-123/attribution",
      expect.anything(),
    );
  });

  it("URL-encodes the session and team identifiers", async () => {
    mockFetch(200);
    await postAssociation(BASE_URL, API_KEY, {
      ...validReq,
      sessionId: "session/with spaces",
      teamId: "team+hash",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.revenium.ai/v2/api/sessions/session%2Fwith%20spaces/attribution?teamId=team%2Bhash",
      expect.anything(),
    );
  });
});

describe("postAssociation — degraded / fail-open cases", () => {
  it.each(["", "not a valid endpoint"])(
    "returns degraded:true for an invalid endpoint (%j) — never throws",
    async (endpoint) => {
      const result = await postAssociation(endpoint, API_KEY, validReq);
      expect(result).toMatchObject({ ok: false, degraded: true, retryable: true });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("treats 404 as a failed write now that the endpoint is live", async () => {
    mockFetch(404);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result.degraded).toBe(true);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ retryable: false });
  });

  it("returns degraded:true on 500 — never throws", async () => {
    mockFetch(500);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result.degraded).toBe(true);
    expect(result).toMatchObject({ retryable: true });
  });

  it("returns degraded:true on 4xx — never throws", async () => {
    mockFetch(422);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result.degraded).toBe(true);
    expect(result).toMatchObject({ retryable: false });
  });

  it("returns degraded:true on network error — never throws", async () => {
    mockFetchNetworkError("ENOTFOUND");
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result.degraded).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("returns degraded:true on timeout — never throws", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (opts.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            });
          }
        }),
    );

    vi.useFakeTimers();
    const fetchPromise = postAssociation(BASE_URL, API_KEY, validReq);

    await vi.advanceTimersByTimeAsync(4000);
    const result = await fetchPromise;
    expect(result.degraded).toBe(true);
    vi.useRealTimers();
  });

  it("includes reason string on degraded result", async () => {
    mockFetch(500);
    const result = await postAssociation(BASE_URL, API_KEY, validReq);
    expect(result.degraded).toBe(true);
    if (result.degraded) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("never propagates errors to caller", async () => {
    mockFetchNetworkError("catastrophic failure");
    await expect(postAssociation(BASE_URL, API_KEY, validReq)).resolves.toBeDefined();
  });

  it("caps text fields to backend validation limits", async () => {
    mockFetch(200);
    await postAssociation(BASE_URL, API_KEY, {
      ...validReq,
      ticketTitle: "t".repeat(501),
      reason: "r".repeat(501),
      repo: "p".repeat(256),
      branch: "b".repeat(256),
    });
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(opts.body as string);
    expect(body.ticketTitle).toHaveLength(500);
    expect(body.reason).toHaveLength(500);
    expect(body.repo).toHaveLength(255);
    expect(body.branch).toHaveLength(255);
  });
});

describe("sanitizeRepoUrl", () => {
  it("strips credentials from https remotes (any case, @ in password)", () => {
    expect(sanitizeRepoUrl("https://user:token@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(sanitizeRepoUrl("HTTPS://user:token@github.com/o/r.git")).toBe(
      "HTTPS://github.com/o/r.git",
    );
    expect(sanitizeRepoUrl("https://user:p@ss@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });

  it("strips credentials from non-http schemes (ssh)", () => {
    expect(sanitizeRepoUrl("ssh://git:secret@github.com/o/r.git")).toBe("ssh://github.com/o/r.git");
  });

  it("strips scp-style userinfo, including an @ inside the username", () => {
    expect(sanitizeRepoUrl("git@github.com:o/r.git")).toBe("github.com:o/r.git");
    expect(sanitizeRepoUrl("domain-user@corp@github.com:o/r.git")).toBe("github.com:o/r.git");
  });

  it("leaves credential-free remotes and local paths unchanged", () => {
    expect(sanitizeRepoUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(sanitizeRepoUrl("/local/path/repo")).toBe("/local/path/repo");
  });
});
