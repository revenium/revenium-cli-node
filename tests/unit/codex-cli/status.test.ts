import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isLegacyFlatKeyForm } from "../../../src/codex-cli/config/loader.js";

vi.mock("../../../src/codex-cli/config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/codex-cli/config/loader.js")>();
  return {
    ...actual,
    readCodexToml: vi.fn(),
  };
});

vi.mock("../../../src/_core/api/health-check.js", () => ({
  generateTestSessionId: vi.fn().mockReturnValue("test-session"),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn().mockResolvedValue({
    id: "metric-1",
    resourceType: "logs",
    processedEvents: 1,
    created: "2026-05-08T00:00:00.000Z",
  }),
}));

import { statusAction } from "../../../src/codex-cli/commands/status.js";
import * as loaderModule from "../../../src/codex-cli/config/loader.js";
import * as otlpClient from "../../../src/_core/api/otlp-client.js";

const STRUCT_VARIANT_TOML = [
  "[otel]",
  'metrics_exporter = "none"',
  "",
  "[otel.exporter.otlp-http]",
  'endpoint = "https://api.revenium.ai/v1/logs"',
  'protocol = "binary"',
  "",
  "[otel.exporter.otlp-http.headers]",
  '"x-api-key" = "hak_test"',
  "",
  "[features]",
  "runtime_metrics = true",
  "",
].join("\n");

describe("isLegacyFlatKeyForm", () => {
  it("returns true for flat dotted-key otel form", () => {
    expect(isLegacyFlatKeyForm('otel.endpoint = "https://api.revenium.ai"')).toBe(true);
  });

  it("returns true for multiple flat dotted-key otel fields", () => {
    const toml = 'otel.endpoint = "https://api.revenium.ai"\notel.api_key = "hak_test"';
    expect(isLegacyFlatKeyForm(toml)).toBe(true);
  });

  it("returns false for struct-variant [otel] table header form", () => {
    expect(isLegacyFlatKeyForm(STRUCT_VARIANT_TOML)).toBe(false);
  });

  it("returns false for a config with no otel section at all", () => {
    expect(isLegacyFlatKeyForm('[model]\nname = "gpt-4"\n')).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isLegacyFlatKeyForm("")).toBe(false);
  });

  it("returns false for a config with [features] only", () => {
    expect(isLegacyFlatKeyForm("[features]\nruntime_metrics = true\n")).toBe(false);
  });
});

describe("statusAction — flat-key diagnostic exit", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits non-zero when config uses flat-key [otel] form", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      'otel.endpoint = "https://api.revenium.ai"\notel.api_key = "hak_test"',
    );

    await statusAction();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("emits a diagnostic message naming the flat-key silent-drop footgun", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(
      'otel.endpoint = "https://api.revenium.ai"\notel.api_key = "hak_test"',
    );

    await statusAction();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("flat-key"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("silent-drop footgun"));
  });

  it("exits non-zero when config file is missing", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(null);

    await statusAction();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit non-zero when config has valid struct-variant form", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(STRUCT_VARIANT_TOML);

    await statusAction();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("uses the Codex mapper-compatible payload for the connection check", async () => {
    vi.mocked(loaderModule.readCodexToml).mockResolvedValue(STRUCT_VARIANT_TOML);

    await statusAction();

    const payload = vi.mocked(otlpClient.sendOtlpLogs).mock.calls[0][2];
    const resourceAttrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));

    expect(resourceAttrs.find((a) => a.key === "service.name")?.value.stringValue).toBe(
      "codex_exec",
    );
    expect(payload.resourceLogs[0].scopeLogs[0].scope?.name).toBe("codex_otel.log_only");
    expect(record.body.stringValue).toBe("codex_cli.token_usage");
    expect(attrs["conversation.id"]?.stringValue).toBe("test-session");
    expect(attrs["event.name"]?.stringValue).toBe("codex.sse_event");
    expect(attrs["event.kind"]?.stringValue).toBe("response.completed");
  });
});
