import { createHash, randomBytes } from "node:crypto";
import type { OTLPTracesPayload } from "../../../_core/types/index.js";
import type { CopilotUsageDay, CopilotUsageBreakdown, CopilotConfig } from "../../types.js";
import { SERVICE_NAME, SCOPE_NAME } from "../../constants.js";

const SPAN_KIND_CLIENT = 3;

export function isValidDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !isNaN(new Date(day).getTime());
}

export function generateTransactionId(
  conversationId: string,
  startTimeUnixNano: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): string {
  const raw = `${conversationId}|${startTimeUnixNano}|${model}|${inputTokens}|${outputTokens}`;
  return createHash("sha256").update(raw).digest("hex").substring(0, 32);
}

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

function dayToUnixNano(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, dayOfMonth);
  return (BigInt(ms) * 1_000_000n).toString();
}

function mapBreakdownToSpan(
  day: CopilotUsageDay,
  breakdown: CopilotUsageBreakdown,
  config: CopilotConfig,
): OTLPTracesPayload["resourceSpans"][0]["scopeSpans"][0]["spans"][0] {
  const startNano = dayToUnixNano(day.day);
  const conversationId = `copilot-usage-${day.day}-${breakdown.language}-${breakdown.editor}`;
  const transactionId = generateTransactionId(conversationId, startNano, "copilot", 0, 0);

  const attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }> = [
    { key: "gen_ai.request.model", value: { stringValue: "copilot" } },
    { key: "gen_ai.system", value: { stringValue: "github" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: 0 } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: 0 } },
    { key: "gen_ai.conversation.id", value: { stringValue: conversationId } },
    { key: "gen_ai.response.finish_reasons", value: { stringValue: "stop" } },
    { key: "transaction_id", value: { stringValue: transactionId } },
    { key: "copilot.usage.date", value: { stringValue: day.day } },
    { key: "copilot.usage.suggestions_count", value: { intValue: breakdown.suggestions_count } },
    { key: "copilot.usage.acceptances_count", value: { intValue: breakdown.acceptances_count } },
    { key: "copilot.usage.lines_suggested", value: { intValue: breakdown.lines_suggested } },
    { key: "copilot.usage.lines_accepted", value: { intValue: breakdown.lines_accepted } },
    { key: "copilot.usage.active_users", value: { intValue: breakdown.active_users } },
    { key: "copilot.usage.language", value: { stringValue: breakdown.language } },
    { key: "copilot.usage.editor", value: { stringValue: breakdown.editor } },
  ];

  if (config.email) {
    attributes.push({ key: "user.email", value: { stringValue: config.email } });
  }

  if (config.organizationName) {
    attributes.push({ key: "organization.name", value: { stringValue: config.organizationName } });
  }

  if (config.productName) {
    attributes.push({ key: "product.name", value: { stringValue: config.productName } });
  }

  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    name: "chat",
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: startNano,
    endTimeUnixNano: startNano,
    attributes,
  };
}

export function buildOtlpPayload(
  days: CopilotUsageDay[],
  config: CopilotConfig,
): OTLPTracesPayload {
  const resourceAttributes: Array<{
    key: string;
    value: { stringValue: string };
  }> = [{ key: "service.name", value: { stringValue: SERVICE_NAME } }];

  if (config.subscriptionTier) {
    resourceAttributes.push({
      key: "revenium.subscription_tier",
      value: { stringValue: config.subscriptionTier },
    });
  }

  const spans: OTLPTracesPayload["resourceSpans"][0]["scopeSpans"][0]["spans"] = [];

  for (const day of days) {
    if (!isValidDay(day.day)) continue;

    for (const breakdown of day.breakdown) {
      spans.push(mapBreakdownToSpan(day, breakdown, config));
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: "1.0.0" },
            spans,
          },
        ],
      },
    ],
  };
}
