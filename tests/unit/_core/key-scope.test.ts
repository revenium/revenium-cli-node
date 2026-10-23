import { describe, it, expect } from "vitest";
import { classifyApiKeyScope } from "../../../src/_core/config/key-scope.js";

describe("classifyApiKeyScope", () => {
  it("classifies a rev_mk_ key as metering", () => {
    expect(classifyApiKeyScope("rev_mk_TENANT1_0123456789abcdef")).toBe("metering");
  });

  it("classifies a rev_rk_ key as read", () => {
    expect(classifyApiKeyScope("rev_rk_TENANT1_0123456789abcdef")).toBe("read");
  });

  it("classifies a rev_sk_ key as write", () => {
    expect(classifyApiKeyScope("rev_sk_TENANT1_0123456789abcdef")).toBe("write");
  });

  it("classifies a hak_ key as legacy", () => {
    expect(classifyApiKeyScope("hak_tenant_0123456789abcdef")).toBe("legacy");
  });

  it("classifies a rev_ key with an unrecognised scope segment as unknown", () => {
    expect(classifyApiKeyScope("rev_zz_TENANT1_0123456789abcdef")).toBe("unknown");
  });
});
