import { describe, it, expect } from "vitest";
import {
  parseEnvContent,
  parseOtelResourceAttributes,
  extractBaseEndpoint,
  getFullOtlpEndpoint,
  getManagementEndpoint,
  findUnknownKeys,
} from "../../../src/_core/config/loader.js";
import { ENV_KEYS as CURSOR_ENV_KEYS } from "../../../src/cursor/constants.js";

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

  it("keeps a backslash before a single quote inside double quotes", () => {
    const result = parseEnvContent('VAR="a\\\'b"');
    expect(result).toEqual({ VAR: "a\\'b" });
  });

  it("keeps a backslash inside single quotes and unescapes only the POSIX quote sequence", () => {
    const result = parseEnvContent("VAR='a\\'\\''b'");
    expect(result).toEqual({ VAR: "a\\'b" });
  });

  it("parses fish shell format", () => {
    const result = parseEnvContent("set -gx MY_VAR 'hello'", true);
    expect(result).toEqual({ MY_VAR: "hello" });
  });

  it("unescapes fish single-quote sequences", () => {
    const result = parseEnvContent("set -gx MY_VAR 'a\\\\b\\'c'", true);
    expect(result).toEqual({ MY_VAR: "a\\b'c" });
  });

  it("keeps a backslash before a single quote inside fish double quotes", () => {
    const result = parseEnvContent('set -gx MY_VAR "a\\\'b"', true);
    expect(result).toEqual({ MY_VAR: "a\\'b" });
  });

  it("unescapes fish double-quote sequences", () => {
    const result = parseEnvContent('set -gx MY_VAR "a\\"b\\$c\\\\d"', true);
    expect(result).toEqual({ MY_VAR: 'a"b$c\\d' });
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

  it("returns an empty string verbatim", () => {
    expect(extractBaseEndpoint("")).toBe("");
  });

  it("keeps a gateway path prefix", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("strips a trailing slash from a prefixed endpoint", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("keeps the prefix while stripping the OTLP path", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/meter/v2/otlp")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("keeps the prefix while stripping the full OTLP logs path", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/meter/v2/otlp/v1/logs")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("keeps the prefix while stripping the AI OTLP path", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/meter/v2/ai/otlp")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("strips a partial metering path", () => {
    expect(extractBaseEndpoint("https://api.revenium.ai/meter")).toBe("https://api.revenium.ai");
    expect(extractBaseEndpoint("https://api.revenium.ai/meter/v2")).toBe("https://api.revenium.ai");
    expect(extractBaseEndpoint("https://gw.example.com/revenium/meter/v2")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("keeps a gateway prefix shaped like a signal suffix", () => {
    expect(extractBaseEndpoint("https://gw.example.com/api/v1/logs")).toBe(
      "https://gw.example.com/api/v1/logs",
    );
    expect(extractBaseEndpoint("https://gw.example.com/api/v1/logs/meter/v2/otlp/v1/logs")).toBe(
      "https://gw.example.com/api/v1/logs",
    );
  });

  it("is idempotent across a setup round-trip", () => {
    const base = extractBaseEndpoint("https://gw.example.com/revenium");
    expect(extractBaseEndpoint(`${getFullOtlpEndpoint(base)}/v1/logs`)).toBe(base);
    expect(extractBaseEndpoint(base)).toBe(base);
  });

  it("is idempotent for a prefix shaped like a signal suffix", () => {
    const base = extractBaseEndpoint("https://gw.example.com/api/v1/logs/meter/v2/otlp/v1/logs");
    expect(extractBaseEndpoint(base)).toBe(base);
    expect(getFullOtlpEndpoint(base)).toBe("https://gw.example.com/api/v1/logs/meter/v2/otlp");
  });

  it("keeps a prefix whose segment merely starts with meter", () => {
    expect(extractBaseEndpoint("https://gw.example.com/metering/revenium")).toBe(
      "https://gw.example.com/metering/revenium",
    );
    expect(extractBaseEndpoint("https://gw.example.com/metering/meter/v2/otlp/v1/logs")).toBe(
      "https://gw.example.com/metering",
    );
  });

  it("strips a metrics signal suffix attached to the metering path", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/meter/v2/otlp/v1/metrics")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("strips the OTLP path regardless of case", () => {
    expect(extractBaseEndpoint("https://gw.example.com/revenium/METER/v2/OTLP")).toBe(
      "https://gw.example.com/revenium",
    );
  });

  it("returns an endpoint with a non-special scheme verbatim", () => {
    expect(extractBaseEndpoint("localhost:8080/revenium")).toBe("localhost:8080/revenium");
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

describe("getManagementEndpoint", () => {
  it("defaults to <origin>/profitstream when no override is given", () => {
    expect(getManagementEndpoint("https://api.dev.revenium.test")).toBe(
      "https://api.dev.revenium.test/profitstream",
    );
  });

  it("strips a trailing slash from the origin before appending the default suffix", () => {
    expect(getManagementEndpoint("https://api.dev.revenium.test/")).toBe(
      "https://api.dev.revenium.test/profitstream",
    );
  });

  it("appends the default suffix after a gateway path prefix", () => {
    expect(getManagementEndpoint("https://gw.example.com/revenium")).toBe(
      "https://gw.example.com/revenium/profitstream",
    );
  });

  it("uses an explicit override verbatim (trailing slash stripped), ignoring the origin", () => {
    expect(
      getManagementEndpoint("https://api.dev.revenium.test", "https://mgmt.example.com/"),
    ).toBe("https://mgmt.example.com");
  });

  it("falls back to the default when the override is an empty or whitespace-only string", () => {
    expect(getManagementEndpoint("https://api.dev.revenium.test", "")).toBe(
      "https://api.dev.revenium.test/profitstream",
    );
    expect(getManagementEndpoint("https://api.dev.revenium.test", "   ")).toBe(
      "https://api.dev.revenium.test/profitstream",
    );
  });
});

describe("findUnknownKeys", () => {
  const CURSOR_KEYS = Object.values(CURSOR_ENV_KEYS);

  it("reports a retired key name written from the old README", () => {
    const content = [
      "REVENIUM_API_KEY=hak_tenant_abc123xyz",
      "REVENIUM_EMAIL=developer@company.com",
    ].join("\n");

    expect(findUnknownKeys(content, CURSOR_KEYS)).toEqual(["REVENIUM_EMAIL"]);
  });

  it("reports nothing when every key is known", () => {
    const content = [
      `${CURSOR_ENV_KEYS.REVENIUM_CURSOR_API_KEY}=key_cursoradmin123`,
      `${CURSOR_ENV_KEYS.REVENIUM_API_KEY}=hak_tenant_abc123xyz`,
      `${CURSOR_ENV_KEYS.SUBSCRIBER_EMAIL}=developer@company.com`,
    ].join("\n");

    expect(findUnknownKeys(content, CURSOR_KEYS)).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const content = `# REVENIUM_EMAIL=developer@company.com\n\n${CURSOR_ENV_KEYS.REVENIUM_API_KEY}=hak_tenant_abc123xyz\n`;

    expect(findUnknownKeys(content, CURSOR_KEYS)).toEqual([]);
  });

  it("reports an exported key by its name, without the prefix", () => {
    expect(findUnknownKeys("export REVENIUM_EMAIL=developer@company.com", CURSOR_KEYS)).toEqual([
      "REVENIUM_EMAIL",
    ]);
  });

  it("sorts several unknown keys", () => {
    const content = ["ZZZ_LAST=1", "REVENIUM_EMAIL=developer@company.com", "AAA_FIRST=1"].join(
      "\n",
    );

    expect(findUnknownKeys(content, CURSOR_KEYS)).toEqual([
      "AAA_FIRST",
      "REVENIUM_EMAIL",
      "ZZZ_LAST",
    ]);
  });

  it("treats a key differing only in case as unknown", () => {
    expect(findUnknownKeys("revenium_api_key=hak_tenant_abc123xyz", CURSOR_KEYS)).toEqual([
      "revenium_api_key",
    ]);
  });

  it("reports nothing for an empty file", () => {
    expect(findUnknownKeys("", CURSOR_KEYS)).toEqual([]);
  });
});
