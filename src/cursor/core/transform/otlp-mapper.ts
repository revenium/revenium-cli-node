import type { OTLPLogsPayload } from "../../../_core/types/index.js";
import type { CursorUsageEvent, CursorConfig } from "../../types.js";
import { SERVICE_NAME, SCOPE_NAME } from "../../constants.js";
import { computeEventHash } from "../sync/deduplicator.js";

const MAX_REPRESENTABLE_EPOCH_MS = 8_640_000_000_000_000;

export function isValidTimestamp(ts: unknown): ts is number {
  return (
    typeof ts === "number" && Number.isInteger(ts) && ts > 0 && ts <= MAX_REPRESENTABLE_EPOCH_MS
  );
}

const INCLUDED_KIND_PREFIX = "included in";

function isIncludedInPlan(kind: unknown): boolean {
  return typeof kind === "string" && kind.trim().toLowerCase().startsWith(INCLUDED_KIND_PREFIX);
}

function cursorReportedCents(event: CursorUsageEvent): number | null {
  if (typeof event.chargedCents === "number" && Number.isFinite(event.chargedCents)) {
    return event.chargedCents;
  }

  return event.isChargeable === false ? 0 : null;
}

export function billableCents(event: CursorUsageEvent): number {
  return (
    cursorReportedCents(event) ??
    (isIncludedInPlan(event.kind) ? 0 : (event.tokenUsage?.totalCents ?? 0))
  );
}

function reportedChargeability(event: CursorUsageEvent): boolean | null {
  const reportedCents = cursorReportedCents(event);

  if (reportedCents !== null) {
    return reportedCents > 0;
  }

  return isIncludedInPlan(event.kind) ? false : null;
}

function mapEventToLogRecord(
  event: CursorUsageEvent,
): OTLPLogsPayload["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0] {
  const timeUnixNano = (BigInt(event.timestamp) * 1_000_000n).toString();

  const transactionId = computeEventHash(event).substring(0, 32);

  const attributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: "transaction_id", value: { stringValue: transactionId } },
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
    { key: "cost_usd", value: { stringValue: (billableCents(event) / 100).toFixed(6) } },
    { key: "user.email", value: { stringValue: event.userEmail } },
    { key: "billing.kind", value: { stringValue: event.kind } },
  ];

  const chargeability = reportedChargeability(event);

  if (chargeability !== null) {
    attributes.push({
      key: "billing.chargeable",
      value: { stringValue: String(chargeability) },
    });
  }

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
