import { describe, it, expect } from "vitest";
import { maskApiKey, maskEmail } from "../../../src/_core/utils/masking.js";

describe("maskApiKey", () => {
  it("masks middle portion keeping prefix and last 4", () => {
    expect(maskApiKey("hak_tenant_abc123xyz")).toBe("hak_***3xyz");
  });

  it("returns *** for short keys", () => {
    expect(maskApiKey("short")).toBe("***");
    expect(maskApiKey("")).toBe("***");
  });

  it("handles exactly 8 character keys", () => {
    const result = maskApiKey("hak_test");
    expect(result).toBe("hak_***test");
  });
});

describe("maskEmail", () => {
  it("masks email keeping first char and domain", () => {
    expect(maskEmail("dev@company.com")).toBe("d***@company.com");
  });

  it("returns *** when no @ found", () => {
    expect(maskEmail("noemail")).toBe("***");
  });

  it("returns *** when @ is at position 0", () => {
    expect(maskEmail("@domain.com")).toBe("***");
  });
});
