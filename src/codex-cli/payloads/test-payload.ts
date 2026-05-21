import type { OTLPLogsPayload } from "../../_core/types/index.js";

export function createCodexMapperTestPayload(sessionId: string): OTLPLogsPayload {
  const nowNs = (BigInt(Date.now()) * BigInt(1_000_000)).toString();
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_exec" } }] },
        scopeLogs: [
          {
            scope: { name: "codex_otel.log_only", version: "1.0.0" },
            logRecords: [
              {
                timeUnixNano: nowNs,
                observedTimeUnixNano: nowNs,
                body: { stringValue: "codex_cli.token_usage" },
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "event.kind", value: { stringValue: "response.completed" } },
                  { key: "transaction_id", value: { stringValue: sessionId } },
                  { key: "conversation.id", value: { stringValue: sessionId } },
                  { key: "model", value: { stringValue: "gpt-5.3-codex" } },
                  { key: "input_token_count", value: { intValue: 0 } },
                  { key: "output_token_count", value: { intValue: 0 } },
                  { key: "cached_token_count", value: { intValue: 0 } },
                  { key: "reasoning_token_count", value: { intValue: 0 } },
                  { key: "tool_token_count", value: { intValue: 0 } },
                  { key: "duration_ms", value: { intValue: 0 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
