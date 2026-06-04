import { describe, it, expect } from "vitest";
import { generateTomlBlock, mergeTomlBlocks } from "../../../src/codex-cli/config/writer.js";
import type { CodexOtelConfig } from "../../../src/codex-cli/config/writer.js";

const minimalConfig: CodexOtelConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
};

const fullConfig: CodexOtelConfig = {
  apiKey: "hak_fullkey456",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  organizationName: "TestOrg",
  productName: "TestProduct",
};

describe("generateTomlBlock — struct-variant [otel] block", () => {
  it("emits inline otlp-http exporter config", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("exporter = { otlp-http = {");
  });

  it("does not use flat dotted-key notation for otel fields", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).not.toMatch(/^otel\.[a-z]/m);
  });

  it("includes the x-api-key in the headers sub-table", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('headers = { "x-api-key" = "hak_testkey123" }');
  });

  it("appends /v1/logs to the endpoint", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
  });

  it("does not double-append /v1/logs when already present", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://api.revenium.ai/meter/v2/otlp/v1/logs",
    };
    const output = generateTomlBlock(config);
    expect(output).not.toContain("/v1/logs/v1/logs");
  });

  it("does not double-append /meter/v2/otlp when already present without /v1/logs", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://api.revenium.ai/meter/v2/otlp",
    };
    const output = generateTomlBlock(config);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
    expect(output).not.toContain("/meter/v2/otlp/meter/v2/otlp");
  });

  it("strips trailing slash from endpoint", () => {
    const config: CodexOtelConfig = { ...minimalConfig, endpoint: "https://api.revenium.ai/" };
    const output = generateTomlBlock(config);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
    expect(output).not.toContain("revenium.ai//");
  });

  it("sets protocol to json", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('protocol = "json"');
  });

  it("sets metrics_exporter to none", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('metrics_exporter = "none"');
  });

  it("selects the otlp-http exporter", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("otlp-http");
  });
});

describe("generateTomlBlock — [features] block", () => {
  it("contains the [features] table header", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("[features]");
  });

  it("sets runtime_metrics = true", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("runtime_metrics = true");
  });

  it("places [features] after [otel] sections", () => {
    const output = generateTomlBlock(minimalConfig);
    const otelIdx = output.indexOf("[otel]");
    const featuresIdx = output.indexOf("[features]");
    expect(featuresIdx).toBeGreaterThan(otelIdx);
  });
});

describe("generateTomlBlock — optional fields", () => {
  it("does not write email to TOML (resource-attrs path only)", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("user@example.com");
    expect(output).not.toContain("email");
  });

  it("does not write organization to TOML", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("TestOrg");
  });

  it("does not write product to TOML", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("TestProduct");
  });

  it("uses DEFAULT_REVENIUM_URL when endpoint is undefined", () => {
    const config: CodexOtelConfig = { apiKey: "hak_test" };
    const output = generateTomlBlock(config);
    expect(output).toContain("revenium.ai");
  });

  it("escapes newlines in inline TOML strings", () => {
    const output = generateTomlBlock({
      apiKey: "hak_test\nmalicious",
      endpoint: "https://api.revenium.ai",
    });
    expect(output).toContain("\\n");
    expect(output).not.toContain("hak_test\nmalicious");
  });
});

describe("mergeTomlBlocks — idempotency on re-run", () => {
  it("does not leave orphaned nested otel sub-tables on a second run", () => {
    const block = generateTomlBlock(minimalConfig);
    const firstRun = mergeTomlBlocks("", block);
    const secondRun = mergeTomlBlocks(firstRun, block);

    const exporterCount = (secondRun.match(/^\s*exporter\s*=\s*\{.*otlp-http.*$/gm) ?? []).length;
    expect(exporterCount).toBe(1);

    expect(secondRun).not.toContain("[otel.exporter.otlp-http]");
    expect(secondRun).not.toContain("[otel.exporter.otlp-http.headers]");
  });
});

describe("mergeTomlBlocks — legacy flat-key removal", () => {
  it("removes legacy flat otel.* dotted keys during migration", () => {
    const legacy = 'otel.endpoint = "https://old.example.com"\notel.api_key = "old_key"\n';
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(legacy, block);
    expect(result).not.toContain("otel.endpoint");
    expect(result).not.toContain("otel.api_key");
    expect(result).toContain("exporter = { otlp-http = {");
  });
});

describe("mergeTomlBlocks — feature flag preservation", () => {
  it("preserves unrelated feature flags while adding runtime_metrics", () => {
    const existing = "[features]\ncode_search = true\nsandbox = false\n";
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(existing, block);
    expect(result).toContain("code_search = true");
    expect(result).toContain("sandbox = false");
    expect(result).toContain("runtime_metrics = true");
  });

  it("removes only exact [otel] sections and preserves [otel_extra]", () => {
    const existing = "[otel_extra]\ncustom = true\n";
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(existing, block);
    expect(result).toContain("custom = true");
  });
});
