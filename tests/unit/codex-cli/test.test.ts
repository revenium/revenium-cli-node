import { describe, expect, it } from "vitest";
import { createCodexMapperTestPayload } from "../../../src/codex-cli/payloads/test-payload.js";

describe("createCodexMapperTestPayload", () => {
  it("uses the same OTLP contract as CodexCliMapper", () => {
    const payload = createCodexMapperTestPayload("test-session");
    const resourceLog = payload.resourceLogs[0];
    const scopeLog = resourceLog.scopeLogs[0];
    const record = scopeLog.logRecords[0];
    const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));

    expect(
      resourceLog.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue,
    ).toBe("codex_exec");
    expect(scopeLog.scope?.name).toBe("codex_otel.log_only");
    expect(record.body.stringValue).toBe("codex_cli.token_usage");
    expect(attrs["conversation.id"]?.stringValue).toBe("test-session");
    expect(attrs["model"]?.stringValue).toBe("gpt-5.3-codex");
    expect(attrs["input_token_count"]?.intValue).toBe(0);
    expect(attrs["output_token_count"]?.intValue).toBe(0);
    expect(attrs["cached_token_count"]?.intValue).toBe(0);
    expect(attrs["reasoning_token_count"]?.intValue).toBe(0);
    expect(attrs["tool_token_count"]?.intValue).toBe(0);
  });

  it("includes event.name and event.kind for CodexCliMapper routing", () => {
    const payload = createCodexMapperTestPayload("test-session");
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));

    expect(attrs["event.name"]?.stringValue).toBe("codex.sse_event");
    expect(attrs["event.kind"]?.stringValue).toBe("response.completed");
  });
});
