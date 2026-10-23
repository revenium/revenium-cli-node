import { hasProxyConfigured } from "../net/proxy.js";
import { sanitizeErrorMessage } from "./resilience.js";

const UNTRUSTED_CA_HINT =
  "Hint: the TLS certificate chain was not trusted. If your proxy inspects TLS traffic, export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem before running this command.";

const INVALID_CERTIFICATE_HINT =
  "Hint: the TLS certificate was rejected as invalid (wrong host name, expired, or revoked). Check the endpoint URL and the system clock, and confirm the certificate with your security team before trusting it.";

const PROXY_HINT =
  "Hint: the connection could not be established. Behind a corporate proxy, export HTTPS_PROXY (and NO_PROXY for hosts that must bypass it).";

const CONFIGURED_PROXY_HINT =
  "Hint: the connection could not be established through the proxy in HTTP_PROXY/HTTPS_PROXY. Check that its host and port are correct and that it is reachable, or list this host in NO_PROXY to bypass it.";

const PROXY_TUNNEL_HINT =
  "Hint: the proxy rejected the CONNECT tunnel. If it requires authentication, include the credentials in HTTPS_PROXY as http://user:password@proxy.corp.example:8080.";

const DNS_HINT =
  "Hint: the hostname could not be resolved. Check the endpoint URL, or export HTTPS_PROXY so the proxy resolves it for you.";

const UNANSWERED_HINT =
  "Hint: the endpoint never answered and the connection was dropped. A firewall that silently discards outbound traffic looks like this - export HTTPS_PROXY, or ask for the endpoint to be allowlisted.";

const PLAINTEXT_RESPONSE_HINT =
  "Hint: the endpoint answered without TLS on an https:// URL, which usually means a proxy intercepted the connection. Export HTTPS_PROXY so the request goes through it explicitly.";

const UNTRUSTED_CA_CODES = [
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "CERT_CHAIN_TOO_LONG",
];

const INVALID_CERTIFICATE_CODES = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
];

const TRANSIENT_CONNECTION_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "EPIPE",
];

const PERMANENT_CONNECTION_CODES = ["EPROTO"];

const CONNECTION_CODES = [...TRANSIENT_CONNECTION_CODES, ...PERMANENT_CONNECTION_CODES];

const DNS_CODES = ["ENOTFOUND", "EAI_AGAIN"];

const UNANSWERED_CODES = [
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
];

const PLAINTEXT_RESPONSE_CODES = ["ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PACKET_LENGTH_TOO_LONG"];

const RETRYABLE_TRANSPORT_CODES = new Set([
  ...TRANSIENT_CONNECTION_CODES,
  ...DNS_CODES,
  ...UNANSWERED_CODES,
]);

const MAX_CAUSE_DEPTH = 4;

const PROXY_TUNNEL_MARKER = "Proxy response";

function hintEntries(codes: string[], hint: string): [string, string][] {
  return codes.map((code) => [code, hint]);
}

const HINT_BY_CODE = new Map<string, string>([
  ...hintEntries(UNTRUSTED_CA_CODES, UNTRUSTED_CA_HINT),
  ...hintEntries(INVALID_CERTIFICATE_CODES, INVALID_CERTIFICATE_HINT),
  ...hintEntries(CONNECTION_CODES, PROXY_HINT),
  ...hintEntries(DNS_CODES, DNS_HINT),
  ...hintEntries(UNANSWERED_CODES, UNANSWERED_HINT),
  ...hintEntries(PLAINTEXT_RESPONSE_CODES, PLAINTEXT_RESPONSE_HINT),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function aggregatedErrors(record: Record<string, unknown>): Record<string, unknown>[] {
  const nested = record.errors;
  return Array.isArray(nested) ? nested.filter(isRecord) : [];
}

function findCodedCause(value: unknown, depth: number): Record<string, unknown> | null {
  if (!isRecord(value) || depth > MAX_CAUSE_DEPTH) {
    return null;
  }

  if (readString(value, "code")) {
    return value;
  }

  for (const nested of aggregatedErrors(value)) {
    const coded = findCodedCause(nested, depth + 1);
    if (coded) {
      return coded;
    }
  }

  return findCodedCause(value.cause, depth + 1);
}

function deepestCause(value: unknown, depth: number): Record<string, unknown> | null {
  if (!isRecord(value) || depth > MAX_CAUSE_DEPTH) {
    return null;
  }

  const current = aggregatedErrors(value)[0] ?? value;
  return deepestCause(current.cause, depth + 1) ?? current;
}

function findDescribableCause(error: Error): Record<string, unknown> | null {
  return findCodedCause(error, 0) ?? deepestCause(error.cause, 0);
}

function describeCause(cause: Record<string, unknown>, outerMessage: string): string | null {
  const code = readString(cause, "code");
  const message = readString(cause, "message");
  const detail = message === outerMessage ? null : message;

  if (!code) {
    return detail;
  }

  return detail ? `${code}: ${detail}` : code;
}

export function networkErrorHint(code: string | null, causeMessage?: string | null): string | null {
  if (causeMessage?.includes(PROXY_TUNNEL_MARKER)) {
    return PROXY_TUNNEL_HINT;
  }

  if (code && CONNECTION_CODES.includes(code) && hasProxyConfigured()) {
    return CONFIGURED_PROXY_HINT;
  }

  return code ? (HINT_BY_CODE.get(code) ?? null) : null;
}

export function enrichNetworkErrorMessage(error: Error): string {
  const cause = findDescribableCause(error);
  const description = cause ? describeCause(cause, error.message) : null;

  if (!cause || !description) {
    return error.message;
  }

  const described = `${error.message} (${description})`;
  const hint = networkErrorHint(readString(cause, "code"), readString(cause, "message"));

  return hint ? `${described}\n${hint}` : described;
}

export function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  const coded = findCodedCause(error, 0);
  const code = coded ? readString(coded, "code") : null;
  return code !== null && RETRYABLE_TRANSPORT_CODES.has(code);
}

export function describeTransportFailure(
  error: Error,
  secret: string,
  timeoutMs: number,
  source?: string,
): string {
  const message =
    error.name === "AbortError"
      ? `Request timeout after ${timeoutMs}ms\n${UNANSWERED_HINT}`
      : enrichNetworkErrorMessage(error);

  return sanitizeErrorMessage(source ? `${source}: ${message}` : message, secret);
}
