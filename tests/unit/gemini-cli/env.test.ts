import { describe, it, expect } from "vitest";
import { buildGeminiEnv } from "../../../src/gemini-cli/config/env.js";
import type { GeminiCliConfig } from "../../../src/gemini-cli/config/loader.js";

const minimalConfig: GeminiCliConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
};

const fullConfig: GeminiCliConfig = {
  ...minimalConfig,
  email: "user@example.com",
  organizationName: "Acme, Inc",
  productName: "Gemini Assistant",
};

describe("buildGeminiEnv", () => {
  it("sends the API key as an OTLP header", () => {
    expect(buildGeminiEnv(minimalConfig).OTEL_EXPORTER_OTLP_HEADERS).toBe(
      "x-api-key=hak_testkey123",
    );
  });

  it("never puts the API key in the resource attributes", () => {
    const env = buildGeminiEnv(fullConfig);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).not.toContain("revenium.api_key");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).not.toContain(fullConfig.apiKey);
  });

  it("overrides an inherited resource attribute value even with no attribution", () => {
    expect(buildGeminiEnv(minimalConfig).OTEL_RESOURCE_ATTRIBUTES).toBe("");
  });

  it("points Gemini at the unified OTLP path, which the exporter suffixes per signal", () => {
    expect(buildGeminiEnv(minimalConfig).GEMINI_TELEMETRY_OTLP_ENDPOINT).toBe(
      "https://api.revenium.ai/meter/v2/otlp",
    );
  });

  it("emits exactly the telemetry variables when no attribution is configured", () => {
    expect(Object.keys(buildGeminiEnv(minimalConfig)).sort()).toEqual([
      "GEMINI_TELEMETRY_ENABLED",
      "GEMINI_TELEMETRY_LOG_PROMPTS",
      "GEMINI_TELEMETRY_OTLP_ENDPOINT",
      "GEMINI_TELEMETRY_OTLP_PROTOCOL",
      "GEMINI_TELEMETRY_TARGET",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_RESOURCE_ATTRIBUTES",
    ]);
  });

  it("escapes commas in resource attribute values", () => {
    expect(buildGeminiEnv(fullConfig).OTEL_RESOURCE_ATTRIBUTES).toContain(
      "organization.name=Acme%2C Inc",
    );
  });

  it("carries attribution values verbatim in the REVENIUM variables", () => {
    const env = buildGeminiEnv(fullConfig);
    expect(env.REVENIUM_SUBSCRIBER_EMAIL).toBe("user@example.com");
    expect(env.REVENIUM_ORGANIZATION_NAME).toBe("Acme, Inc");
    expect(env.REVENIUM_PRODUCT_NAME).toBe("Gemini Assistant");
  });
});

describe("buildGeminiEnv — prompt and tool-argument export", () => {
  it("turns prompt logging off, which is also the gate on tool-call arguments", () => {
    expect(buildGeminiEnv(minimalConfig).GEMINI_TELEMETRY_LOG_PROMPTS).toBe("false");
  });
});
