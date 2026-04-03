import type { OTLPLogsPayload } from "../../src/_core/types/index.js";
import { createTestPayload, generateTestSessionId } from "../../src/_core/api/health-check.js";
import { buildOtlpPayload } from "../../src/cursor/core/transform/otlp-mapper.js";
import { createUsageEvent, createCursorConfig } from "./fixtures.js";

export const REQUIRED_LOG_ATTRIBUTE_KEYS = [
  "session.id",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "duration_ms",
] as const;

export const REQUIRED_RESOURCE_ATTRIBUTE_KEYS = ["service.name"] as const;

export const PROVIDER_SERVICE_NAMES = {
  "claude-code": "claude-code",
  "gemini-cli": "gemini-cli",
  cursor: "cursor-ide",
} as const;

export const PROVIDER_BODY_PATTERNS = {
  "claude-code": "claude-code.api_request",
  "gemini-cli": "gemini-cli.api_request",
  cursor: "cursor_ide.api_response",
} as const;

export const CURSOR_SPECIFIC_ATTRIBUTE_KEYS = [
  "billing.kind",
  "cursor.token_fee",
  "cursor.requests_costs",
  "cursor.is_token_based",
] as const;

export type ProviderName = keyof typeof PROVIDER_SERVICE_NAMES;

export function createProviderTestPayload(provider: ProviderName): OTLPLogsPayload {
  if (provider === "cursor") {
    const event = createUsageEvent();
    const config = createCursorConfig();
    return buildOtlpPayload([event], config);
  }

  const sessionId = generateTestSessionId();
  return createTestPayload(sessionId, PROVIDER_SERVICE_NAMES[provider]);
}
