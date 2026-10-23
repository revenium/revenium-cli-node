export type ApiKeyScope = "metering" | "read" | "write" | "legacy" | "unknown";

export const REVENIUM_KEY_SCOPE_PREFIXES: Record<string, ApiKeyScope> = {
  rev_mk_: "metering",
  rev_rk_: "read",
  rev_sk_: "write",
};

export const LEGACY_KEY_PREFIX = "hak_";

export const ACCEPTED_KEY_PREFIXES = [
  ...Object.entries(REVENIUM_KEY_SCOPE_PREFIXES)
    .filter(([, scope]) => scope !== "read")
    .map(([prefix]) => prefix),
  LEGACY_KEY_PREFIX,
];

export const UNSUPPORTED_KEY_PREFIX_MESSAGE = `API key must start with ${ACCEPTED_KEY_PREFIXES.map(
  (prefix) => `"${prefix}"`,
).join(" or ")}`;

export const READ_KEY_REJECTION_MESSAGE =
  "A read-only key (rev_rk_) cannot send metering data. Create a metering key (rev_mk_) in the Revenium dashboard and use that instead.";

export function classifyApiKeyScope(apiKey: string): ApiKeyScope {
  const scope = Object.entries(REVENIUM_KEY_SCOPE_PREFIXES).find(([prefix]) =>
    apiKey.startsWith(prefix),
  );

  if (scope) return scope[1];
  if (apiKey.startsWith(LEGACY_KEY_PREFIX)) return "legacy";

  return "unknown";
}
