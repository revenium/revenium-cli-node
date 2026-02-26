import { describe, it, expect } from "vitest";
import {
  escapeShellValue,
  escapeDoubleQuotedShellValue,
  escapeFishValue,
  escapeResourceAttributeValue,
} from "../../../src/_core/shell/escaping.js";

describe("escapeShellValue", () => {
  it("wraps in single quotes", () => {
    expect(escapeShellValue("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(escapeShellValue("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(escapeShellValue("")).toBe("''");
  });
});

describe("escapeDoubleQuotedShellValue", () => {
  it("wraps in double quotes", () => {
    expect(escapeDoubleQuotedShellValue("hello")).toBe('"hello"');
  });

  it("escapes backslashes, double quotes, dollar signs and backticks", () => {
    expect(escapeDoubleQuotedShellValue('a\\b"c$d`e')).toBe('"a\\\\b\\"c\\$d\\`e"');
  });
});

describe("escapeFishValue", () => {
  it("wraps in single quotes", () => {
    expect(escapeFishValue("hello")).toBe("'hello'");
  });

  it("escapes backslashes and single quotes", () => {
    expect(escapeFishValue("it's\\path")).toBe("'it\\'s\\\\path'");
  });
});

describe("escapeResourceAttributeValue", () => {
  it("percent-encodes special characters", () => {
    expect(escapeResourceAttributeValue("a,b=c")).toBe("a%2Cb%3Dc");
  });

  it("encodes percent signs first", () => {
    expect(escapeResourceAttributeValue("50%")).toBe("50%25");
  });

  it("encodes double quotes", () => {
    expect(escapeResourceAttributeValue('say "hi"')).toBe("say %22hi%22");
  });

  it("leaves safe characters untouched", () => {
    expect(escapeResourceAttributeValue("hello world")).toBe("hello world");
  });
});
