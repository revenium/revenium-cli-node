import { describe, it, expect } from "vitest";
import {
  parseEnvContent,
  parseOtelResourceAttributes,
  extractBaseEndpoint,
  getFullOtlpEndpoint,
} from "../../../src/_core/config/loader.js";

describe("parseEnvContent", () => {
  it("parses simple KEY=VALUE", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips export prefix", () => {
    const result = parseEnvContent("export MY_VAR=hello");
    expect(result).toEqual({ MY_VAR: "hello" });
  });

  it("strips surrounding double quotes", () => {
    const result = parseEnvContent('MY_VAR="hello world"');
    expect(result).toEqual({ MY_VAR: "hello world" });
  });

  it("strips surrounding single quotes", () => {
    const result = parseEnvContent("MY_VAR='hello world'");
    expect(result).toEqual({ MY_VAR: "hello world" });
  });

  it("skips comments and blank lines", () => {
    const result = parseEnvContent("# comment\n\nFOO=bar\n# another");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("handles escaped characters inside double quotes", () => {
    const result = parseEnvContent('VAR="hello \\"world\\""');
    expect(result).toEqual({ VAR: 'hello "world"' });
  });

  it("parses fish shell format", () => {
    const result = parseEnvContent("set -gx MY_VAR 'hello'", true);
    expect(result).toEqual({ MY_VAR: "hello" });
  });

  it("handles fish shell with unquoted value", () => {
    const result = parseEnvContent("set -gx MY_VAR hello", true);
    expect(result).toEqual({ MY_VAR: "hello" });
  });

  it("ignores lines without equals sign (non-fish)", () => {
    const result = parseEnvContent("NOEQUALS");
    expect(result).toEqual({});
  });
});

describe("parseOtelResourceAttributes", () => {
  it("parses comma-separated key=value pairs", () => {
    const result = parseOtelResourceAttributes("organization.name=Acme,product.name=Widget");
    expect(result).toEqual({
      "organization.name": "Acme",
      "product.name": "Widget",
    });
  });

  it("decodes percent-encoded values", () => {
    const result = parseOtelResourceAttributes("name=Hello%2C%20World");
    expect(result).toEqual({ name: "Hello, World" });
  });

  it("returns empty for empty/null input", () => {
    expect(parseOtelResourceAttributes("")).toEqual({});
    expect(parseOtelResourceAttributes(null as unknown as string)).toEqual({});
  });

  it("skips malformed entries", () => {
    const result = parseOtelResourceAttributes("goodkey=val,badentry,ok=yes");
    expect(result).toEqual({ goodkey: "val", ok: "yes" });
  });
});

describe("extractBaseEndpoint", () => {
  it("strips /meter/v2/otlp path", () => {
    expect(extractBaseEndpoint("https://api.revenium.ai/meter/v2/otlp")).toBe(
      "https://api.revenium.ai",
    );
  });

  it("strips /meter/v2/ai/otlp path", () => {
    expect(extractBaseEndpoint("https://api.revenium.ai/meter/v2/ai/otlp")).toBe(
      "https://api.revenium.ai",
    );
  });

  it("returns origin for plain URLs", () => {
    expect(extractBaseEndpoint("https://api.revenium.ai")).toBe("https://api.revenium.ai");
  });

  it("returns raw string for invalid URL", () => {
    expect(extractBaseEndpoint("not-a-url")).toBe("not-a-url");
  });
});

describe("getFullOtlpEndpoint", () => {
  it("appends OTLP path", () => {
    expect(getFullOtlpEndpoint("https://api.revenium.ai")).toBe(
      "https://api.revenium.ai/meter/v2/otlp",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(getFullOtlpEndpoint("https://api.revenium.ai/")).toBe(
      "https://api.revenium.ai/meter/v2/otlp",
    );
  });
});
