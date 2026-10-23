import { describe, it, expect } from "vitest";
import { computeBreakdownHash } from "../../../src/copilot/core/sync/deduplicator.js";
import { createCopilotUsageDay, createCopilotBreakdown } from "../../helpers/fixtures.js";

describe("computeBreakdownHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeBreakdownHash(createCopilotUsageDay(), createCopilotBreakdown());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a chat row's hash unchanged by the surface field", () => {
    expect(computeBreakdownHash(createCopilotUsageDay(), createCopilotBreakdown())).toBe(
      "a8abf298c9e1d3069f2a0bcb63d880ad3e41ca3258d25ea2dc36df4f327c03db",
    );
  });

  it("hashes CLI and app rows of one developer differently", () => {
    const day = createCopilotUsageDay();

    expect(computeBreakdownHash(day, createCopilotBreakdown({ surface: "cli" }))).not.toBe(
      computeBreakdownHash(day, createCopilotBreakdown({ surface: "app" })),
    );
  });

  it("is deterministic for the same inputs", () => {
    const day = createCopilotUsageDay();
    const breakdown = createCopilotBreakdown();
    expect(computeBreakdownHash(day, breakdown)).toBe(computeBreakdownHash(day, breakdown));
  });

  it("produces different hashes for different days", () => {
    const breakdown = createCopilotBreakdown();
    const h1 = computeBreakdownHash(createCopilotUsageDay({ day: "2024-06-15" }), breakdown);
    const h2 = computeBreakdownHash(createCopilotUsageDay({ day: "2024-06-16" }), breakdown);
    expect(h1).not.toBe(h2);
  });

  it("produces different hashes for different languages", () => {
    const day = createCopilotUsageDay();
    const h1 = computeBreakdownHash(day, createCopilotBreakdown({ language: "typescript" }));
    const h2 = computeBreakdownHash(day, createCopilotBreakdown({ language: "python" }));
    expect(h1).not.toBe(h2);
  });

  it("produces different hashes for different editors", () => {
    const day = createCopilotUsageDay();
    const h1 = computeBreakdownHash(day, createCopilotBreakdown({ editor: "vscode" }));
    const h2 = computeBreakdownHash(day, createCopilotBreakdown({ editor: "neovim" }));
    expect(h1).not.toBe(h2);
  });

  it("produces same hash when only counts differ (natural key dedup)", () => {
    const day = createCopilotUsageDay();
    const h1 = computeBreakdownHash(day, createCopilotBreakdown({ suggestions_count: 100 }));
    const h2 = computeBreakdownHash(day, createCopilotBreakdown({ suggestions_count: 200 }));
    expect(h1).toBe(h2);
  });
});
