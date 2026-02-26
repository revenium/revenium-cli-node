import { describe, it, expect } from "vitest";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
} from "../../../src/_core/config/validator.js";

describe("validateApiKey", () => {
  it("accepts valid hak_ key with tenant and suffix", () => {
    const result = validateApiKey("hak_tenant_abc123xyz");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty key", () => {
    const result = validateApiKey("");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("API key is required");
  });

  it("rejects key without hak_ prefix", () => {
    const result = validateApiKey("invalid_tenant_key");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("hak_");
  });

  it("rejects key with fewer than 3 underscore parts", () => {
    const result = validateApiKey("hak_shortkey");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("hak_{tenant}_{key}")]),
    );
  });

  it("rejects key shorter than 12 characters", () => {
    const result = validateApiKey("hak_a_b");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("too short")]));
  });
});

describe("validateEmail", () => {
  it("accepts valid email", () => {
    const result = validateEmail("dev@company.com");
    expect(result.valid).toBe(true);
  });

  it("accepts empty email (optional field)", () => {
    const result = validateEmail("");
    expect(result.valid).toBe(true);
  });

  it("rejects invalid email format", () => {
    const result = validateEmail("not-an-email");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid email");
  });

  it("rejects email exceeding 254 chars", () => {
    const longEmail = `${"a".repeat(250)}@b.com`;
    const result = validateEmail(longEmail);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("too long");
  });
});

describe("validateEndpointUrl", () => {
  it("accepts valid HTTPS URL", () => {
    const result = validateEndpointUrl("https://api.revenium.ai");
    expect(result.valid).toBe(true);
  });

  it("accepts HTTP for localhost", () => {
    const result = validateEndpointUrl("http://localhost:3000");
    expect(result.valid).toBe(true);
  });

  it("accepts HTTP for 127.0.0.1", () => {
    const result = validateEndpointUrl("http://127.0.0.1:8080");
    expect(result.valid).toBe(true);
  });

  it("rejects empty URL", () => {
    const result = validateEndpointUrl("");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Endpoint URL is required");
  });

  it("rejects HTTP for non-localhost", () => {
    const result = validateEndpointUrl("http://example.com");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("HTTPS");
  });

  it("rejects URL with embedded credentials", () => {
    const result = validateEndpointUrl("https://user:pass@example.com");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("credentials");
  });

  it("rejects malformed URL", () => {
    const result = validateEndpointUrl("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid endpoint URL");
  });
});
