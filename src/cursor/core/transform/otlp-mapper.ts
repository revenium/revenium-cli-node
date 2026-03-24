import type { OTLPLogsPayload } from "../../../_core/types/index.js";
import type { CursorUsageEvent, CursorConfig } from "../../types.js";
import { SERVICE_NAME, SCOPE_NAME } from "../../constants.js";

export function isValidTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && Number.isInteger(ts) && ts > 0;
}

function mapEventToLogRecord(
  event: CursorUsageEvent,
): OTLPLogsPayload["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0] {
  const timeUnixNano = (BigInt(event.timestamp) * 1_000_000n).toString();

  const attributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: "model", value: { stringValue: event.model } },
    {
      key: "input_tokens",
      value: { stringValue: String(event.tokenUsage?.inputTokens ?? 0) },
    },
    {
      key: "output_tokens",
      value: { stringValue: String(event.tokenUsage?.outputTokens ?? 0) },
    },
    {
      key: "cache_read_tokens",
      value: { stringValue: String(event.tokenUsage?.cacheReadTokens ?? 0) },
    },
    {
      key: "cache_creation_tokens",
      value: { stringValue: String(event.tokenUsage?.cacheWriteTokens ?? 0) },
    },
    {
      key: "cost_usd",
      value: {
        stringValue: ((event.tokenUsage?.totalCents ?? 0) / 100).toFixed(6),
      },
    },
    { key: "user.email", value: { stringValue: event.userEmail } },
    { key: "billing.kind", value: { stringValue: event.kind } },
    {
      key: "cursor.token_fee",
      value: { stringValue: String(event.cursorTokenFee) },
    },
    {
      key: "cursor.requests_costs",
      value: { stringValue: String(event.requestsCosts) },
    },
    {
      key: "cursor.is_token_based",
      value: { stringValue: String(event.isTokenBasedCall) },
    },
  ];

  return {
    timeUnixNano,
    body: { stringValue: "cursor_ide.api_response" },
    attributes,
  };
}

export function buildOtlpPayload(
  events: CursorUsageEvent[],
  config: CursorConfig,
): OTLPLogsPayload {
  const resourceAttributes: Array<{
    key: string;
    value: { stringValue: string };
  }> = [{ key: "service.name", value: { stringValue: SERVICE_NAME } }];

  if (config.organizationName) {
    resourceAttributes.push({
      key: "organization.name",
      value: { stringValue: config.organizationName },
    });
  }

  if (config.productName) {
    resourceAttributes.push({
      key: "product.name",
      value: { stringValue: config.productName },
    });
  }

  if (config.email) {
    resourceAttributes.push({
      key: "user.email",
      value: { stringValue: config.email },
    });
  }

  const logRecords = events.map(mapEventToLogRecord);

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: SCOPE_NAME, version: "1.0.0" },
            logRecords,
          },
        ],
      },
    ],
  };
}
