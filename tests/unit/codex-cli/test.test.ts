import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn().mockResolvedValue({
    id: "metric-1",
    resourceType: "logs",
    processedEvents: 1,
    created: "2026-05-08T00:00:00.000Z",
  }),
}));

import { createCodexMapperTestPayload } from "../../../src/codex-cli/payloads/test-payload.js";
import { testAction } from "../../../src/codex-cli/commands/test.js";
import * as otlpClient from "../../../src/_core/api/otlp-client.js";

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
    expect(attrs["cache_write_token_count"]?.intValue).toBe(0);
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

describe("testAction — configuration written by the export opt-out", () => {
  const OPT_OUT_TOML = [
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[features]",
    "runtime_metrics = true",
    "",
  ].join("\n");

  let tempDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const configPath = () => join(tempDir, "config.toml");

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "codex-test-optout-"));
    writeFileSync(configPath(), OPT_OUT_TOML);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sends the test metric using the key kept outside config.toml", async () => {
    writeFileSync(
      join(tempDir, "revenium.env"),
      "return 0 2>/dev/null\nREVENIUM_API_KEY='hak_optout'\nREVENIUM_ENDPOINT='https://api.revenium.ai'\n",
    );

    await testAction({ configPath: configPath() });

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(otlpClient.sendOtlpLogs).toHaveBeenCalledWith(
      "https://api.revenium.ai",
      "hak_optout",
      expect.anything(),
    );
  });

  it("exits non-zero when no key was persisted anywhere", async () => {
    await testAction({ configPath: configPath() });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(otlpClient.sendOtlpLogs).not.toHaveBeenCalled();
  });
});
