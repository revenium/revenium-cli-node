import { describe, it, expect } from "vitest";
import { extractOtelValues } from "../../../src/codex-cli/config/loader.js";

describe("extractOtelValues", () => {
  it("normalizes legacy [otel] endpoint with /v1/logs suffix", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai/v1/logs"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("normalizes legacy [otel] endpoint with trailing slash", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai/v1/logs/"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("returns clean base endpoint when legacy [otel] has no suffix", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai"
api_key = "hak_test_key"
`;
    const result = extractOtelValues(toml);
    expect(result).toEqual({ endpoint: "https://api.revenium.ai", apiKey: "hak_test_key" });
  });

  it("returns null when [otel] section is missing", () => {
    const toml = `
[features]
runtime_metrics = true
`;
    expect(extractOtelValues(toml)).toBeNull();
  });

  it("returns null when [otel] has endpoint but no api_key", () => {
    const toml = `
[otel]
endpoint = "https://api.revenium.ai"
`;
    expect(extractOtelValues(toml)).toBeNull();
  });
});
