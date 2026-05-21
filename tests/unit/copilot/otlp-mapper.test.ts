import { describe, it, expect } from "vitest";
import {
  buildOtlpPayload,
  isValidDay,
  generateTransactionId,
} from "../../../src/copilot/core/transform/otlp-mapper.js";
import {
  createCopilotUsageDay,
  createCopilotBreakdown,
  createCopilotConfig,
} from "../../helpers/fixtures.js";

describe("buildOtlpPayload", () => {
  it("returns valid OTLP traces structure", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].scopeSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it("sets service.name to github-copilot-cli", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const attrs = payload.resourceSpans[0].resource?.attributes ?? [];
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe("github-copilot-cli");
  });

  it("sets scope name to github_copilot.log_only", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const scope = payload.resourceSpans[0].scopeSpans[0].scope;
    expect(scope?.name).toBe("github_copilot.log_only");
    expect(scope?.version).toBe("1.0.0");
  });

  it("emits spans with name chat", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("chat");
    expect(span.kind).toBe(3);
  });

  it("includes gen_ai.* semantic convention attributes", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const getStr = (key: string) => attrs.find((a) => a.key === key)?.value.stringValue;
    const getInt = (key: string) => attrs.find((a) => a.key === key)?.value.intValue;

    expect(getStr("gen_ai.request.model")).toBe("copilot");
    expect(getStr("gen_ai.system")).toBe("github");
    expect(getInt("gen_ai.usage.input_tokens")).toBe(0);
    expect(getInt("gen_ai.usage.output_tokens")).toBe(0);
    expect(getStr("gen_ai.response.finish_reasons")).toBe("stop");
    expect(getStr("gen_ai.conversation.id")).toBeDefined();
  });

  it("includes revenium.subscription_tier when present", () => {
    const config = createCopilotConfig({ subscriptionTier: "business" });
    const payload = buildOtlpPayload([createCopilotUsageDay()], config);
    const attrs = payload.resourceSpans[0].resource?.attributes ?? [];
    const tier = attrs.find((a) => a.key === "revenium.subscription_tier");
    expect(tier?.value.stringValue).toBe("business");
  });

  it("maps copilot usage breakdown fields to span attributes", () => {
    const breakdown = createCopilotBreakdown({
      language: "python",
      editor: "neovim",
      suggestions_count: 200,
      acceptances_count: 120,
      lines_suggested: 400,
      lines_accepted: 240,
      active_users: 8,
    });
    const day = createCopilotUsageDay({ breakdown: [breakdown] });
    const payload = buildOtlpPayload([day], createCopilotConfig());
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;

    const getStr = (key: string) => attrs.find((a) => a.key === key)?.value.stringValue;
    const getInt = (key: string) => attrs.find((a) => a.key === key)?.value.intValue;

    expect(getStr("copilot.usage.language")).toBe("python");
    expect(getStr("copilot.usage.editor")).toBe("neovim");
    expect(getInt("copilot.usage.suggestions_count")).toBe(200);
    expect(getInt("copilot.usage.acceptances_count")).toBe(120);
    expect(getInt("copilot.usage.lines_suggested")).toBe(400);
    expect(getInt("copilot.usage.lines_accepted")).toBe(240);
    expect(getInt("copilot.usage.active_users")).toBe(8);
  });

  it("includes user.email in span attributes when present", () => {
    const config = createCopilotConfig({ email: "admin@co.com" });
    const payload = buildOtlpPayload([createCopilotUsageDay()], config);
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const email = attrs.find((a) => a.key === "user.email");
    expect(email?.value.stringValue).toBe("admin@co.com");
  });

  it("includes organization.name in span attributes when present", () => {
    const config = createCopilotConfig({ organizationName: "Acme" });
    const payload = buildOtlpPayload([createCopilotUsageDay()], config);
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const org = attrs.find((a) => a.key === "organization.name");
    expect(org?.value.stringValue).toBe("Acme");
  });

  it("includes transaction_id in span attributes", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const txId = attrs.find((a) => a.key === "transaction_id");
    expect(txId?.value.stringValue).toMatch(/^[a-f0-9]{32}$/);
  });

  it("generates valid traceId and spanId", () => {
    const payload = buildOtlpPayload([createCopilotUsageDay()], createCopilotConfig());
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("handles multiple days with multiple breakdowns", () => {
    const day1 = createCopilotUsageDay({
      day: "2024-06-15",
      breakdown: [
        createCopilotBreakdown({ language: "typescript" }),
        createCopilotBreakdown({ language: "python" }),
      ],
    });
    const day2 = createCopilotUsageDay({
      day: "2024-06-16",
      breakdown: [createCopilotBreakdown({ language: "go" })],
    });
    const payload = buildOtlpPayload([day1, day2], createCopilotConfig());
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(3);
  });

  it("skips days with invalid date format", () => {
    const day = createCopilotUsageDay({ day: "invalid-date" });
    const payload = buildOtlpPayload([day], createCopilotConfig());
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(0);
  });

  it("returns empty spans for empty days array", () => {
    const payload = buildOtlpPayload([], createCopilotConfig());
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(0);
  });
});

describe("isValidDay", () => {
  it("accepts valid YYYY-MM-DD format", () => {
    expect(isValidDay("2024-06-15")).toBe(true);
  });

  it("rejects invalid date strings", () => {
    expect(isValidDay("not-a-date")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidDay("")).toBe(false);
  });

  it("rejects non-date format", () => {
    expect(isValidDay("06/15/2024")).toBe(false);
  });
});

describe("generateTransactionId", () => {
  it("returns a 32-character hex string", () => {
    const id = generateTransactionId("conv-1", "123456", "copilot", 0, 0);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("is deterministic", () => {
    const id1 = generateTransactionId("conv-1", "123456", "copilot", 0, 0);
    const id2 = generateTransactionId("conv-1", "123456", "copilot", 0, 0);
    expect(id1).toBe(id2);
  });

  it("differs for different conversation IDs", () => {
    const id1 = generateTransactionId("conv-1", "123456", "copilot", 0, 0);
    const id2 = generateTransactionId("conv-2", "123456", "copilot", 0, 0);
    expect(id1).not.toBe(id2);
  });

  it("differs for different timestamps", () => {
    const id1 = generateTransactionId("conv-1", "123456", "copilot", 0, 0);
    const id2 = generateTransactionId("conv-1", "789012", "copilot", 0, 0);
    expect(id1).not.toBe(id2);
  });
});
