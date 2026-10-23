import { describe, it, expect } from "vitest";
import {
  networkErrorHint,
  enrichNetworkErrorMessage,
  isRetryableTransportError,
} from "../../../src/_core/api/network-error.js";

function fetchFailure(cause: unknown): Error {
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("networkErrorHint", () => {
  it("points at NODE_EXTRA_CA_CERTS for untrusted chain codes", () => {
    expect(networkErrorHint("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")).toContain("NODE_EXTRA_CA_CERTS");
    expect(networkErrorHint("SELF_SIGNED_CERT_IN_CHAIN")).toContain("NODE_EXTRA_CA_CERTS");
    expect(networkErrorHint("DEPTH_ZERO_SELF_SIGNED_CERT")).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("does not send mismatched, expired or revoked certificates to a CA file", () => {
    for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_REVOKED"]) {
      const hint = networkErrorHint(code);
      expect(hint).not.toContain("NODE_EXTRA_CA_CERTS");
      expect(hint).toContain("rejected as invalid");
    }
  });

  it("points at HTTPS_PROXY for connection codes", () => {
    expect(networkErrorHint("ECONNREFUSED")).toContain("HTTPS_PROXY");
    expect(networkErrorHint("EHOSTUNREACH")).toContain("HTTPS_PROXY");
    expect(networkErrorHint("EPIPE")).toContain("HTTPS_PROXY");
  });

  it("blames the configured proxy instead of asking for one that is already set", () => {
    process.env.HTTPS_PROXY = "http://proxy.corp.example:8080";

    try {
      const hint = networkErrorHint("ECONNREFUSED");
      expect(hint).toContain("could not be established through the proxy");
      expect(hint).not.toContain("Behind a corporate proxy, export");
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it("names the dropped connection for timeout codes", () => {
    expect(networkErrorHint("ETIMEDOUT")).toContain("never answered");
    expect(networkErrorHint("UND_ERR_CONNECT_TIMEOUT")).toContain("never answered");
    expect(networkErrorHint("ERR_TLS_HANDSHAKE_TIMEOUT")).toContain("never answered");
  });

  it("names the interception for a plaintext answer on a TLS port", () => {
    expect(networkErrorHint("ERR_SSL_WRONG_VERSION_NUMBER")).toContain("answered without TLS");
  });

  it("names proxy authentication when the tunnel is rejected", () => {
    expect(
      networkErrorHint("UND_ERR_ABORTED", "Proxy response (407) !== 200 when HTTP Tunneling"),
    ).toContain("credentials in HTTPS_PROXY");
  });

  it("names the resolution failure for DNS codes", () => {
    expect(networkErrorHint("ENOTFOUND")).toContain("hostname could not be resolved");
    expect(networkErrorHint("EAI_AGAIN")).toContain("hostname could not be resolved");
  });

  it("returns null for an unrecognised code", () => {
    expect(networkErrorHint("EWEIRD")).toBeNull();
    expect(networkErrorHint(null)).toBeNull();
  });
});

describe("enrichNetworkErrorMessage", () => {
  it("leaves a causeless message untouched", () => {
    expect(enrichNetworkErrorMessage(new Error("OTLP request failed: 400 Bad Request"))).toBe(
      "OTLP request failed: 400 Bad Request",
    );
  });

  it("appends the cause and the hint on its own line", () => {
    const message = enrichNetworkErrorMessage(
      fetchFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:45999" }),
    );
    expect(message).toContain("fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:45999)");
    expect(message).toContain("\nHint:");
  });

  it("reports the cause message alone when no code is present", () => {
    expect(enrichNetworkErrorMessage(fetchFailure({ message: "bad port" }))).toBe(
      "fetch failed (bad port)",
    );
  });

  it("reads the first member of an AggregateError cause", () => {
    const message = enrichNetworkErrorMessage(
      fetchFailure({
        errors: [
          { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:45999" },
          { code: "ENETUNREACH", message: "connect ENETUNREACH ::1:45999" },
        ],
      }),
    );
    expect(message).toContain("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:45999");
    expect(message).toContain("HTTPS_PROXY");
  });

  it("walks past a codeless cause to the proxy tunnel rejection underneath", () => {
    const message = enrichNetworkErrorMessage(
      fetchFailure({
        code: 0,
        message: "Request was cancelled.",
        cause: {
          code: "UND_ERR_ABORTED",
          message: "Proxy response (407) !== 200 when HTTP Tunneling",
        },
      }),
    );
    expect(message).toContain("UND_ERR_ABORTED: Proxy response (407)");
    expect(message).toContain("credentials in HTTPS_PROXY");
  });

  it("names a code carried directly on the thrown error", () => {
    const message = enrichNetworkErrorMessage(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    expect(message).toContain("socket hang up (ECONNRESET)");
    expect(message).toContain("HTTPS_PROXY");
  });

  it("reports the cause without a hint when the code is unknown", () => {
    const message = enrichNetworkErrorMessage(fetchFailure({ code: "EWEIRD", message: "odd" }));
    expect(message).toBe("fetch failed (EWEIRD: odd)");
  });
});

describe("isRetryableTransportError", () => {
  it("retries a refused connection reported through the cause chain", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "ECONNREFUSED" }))).toBe(true);
  });

  it("retries a reset connection", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableTransportError(fetchFailure({ code: "UND_ERR_SOCKET" }))).toBe(true);
  });

  it("retries a refused connection nested in an AggregateError cause", () => {
    expect(isRetryableTransportError(fetchFailure({ errors: [{ code: "ECONNREFUSED" }] }))).toBe(
      true,
    );
  });

  it("retries a coded sibling when the first aggregated member carries no code", () => {
    expect(
      isRetryableTransportError(
        fetchFailure({ errors: [{ message: "boom" }, { code: "ECONNREFUSED" }] }),
      ),
    ).toBe(true);
  });

  it("retries the aggregate's own code when no member carries one", () => {
    expect(
      isRetryableTransportError(
        fetchFailure({ code: "ECONNREFUSED", errors: [{ message: "boom" }] }),
      ),
    ).toBe(true);
  });

  it("retries a code carried directly on the thrown error", () => {
    expect(isRetryableTransportError(Object.assign(new Error("boom"), { code: "ETIMEDOUT" }))).toBe(
      true,
    );
  });

  it("does not retry a TLS protocol mismatch", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "EPROTO" }))).toBe(false);
  });

  it("retries a connection the server closed while the request body was still being written", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "EPIPE" }))).toBe(true);
  });

  it("retries a client-side timeout", () => {
    expect(isRetryableTransportError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(
      true,
    );
  });

  it("does not retry a certificate failure", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(
      false,
    );
  });

  it("does not retry a malformed address", () => {
    expect(isRetryableTransportError(fetchFailure({ code: "ERR_INVALID_URL" }))).toBe(false);
  });

  it("does not retry an error with no resolvable code", () => {
    expect(isRetryableTransportError(new Error("fetch failed"))).toBe(false);
  });

  it("does not retry a non-Error throw", () => {
    expect(isRetryableTransportError("fetch failed")).toBe(false);
  });
});
