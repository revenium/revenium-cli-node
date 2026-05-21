import { describe, it, expect } from "vitest";
import { computeBreakdownHash, Deduplicator } from "../../../src/copilot/core/sync/deduplicator.js";
import { createCopilotUsageDay, createCopilotBreakdown } from "../../helpers/fixtures.js";

describe("computeBreakdownHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeBreakdownHash(createCopilotUsageDay(), createCopilotBreakdown());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
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

describe("Deduplicator", () => {
  it("initializes with existing hashes", () => {
    const dedup = new Deduplicator(["abc", "def"]);
    expect(dedup.isDuplicate("abc")).toBe(true);
    expect(dedup.isDuplicate("xyz")).toBe(false);
  });

  it("mark adds hash to seen set", () => {
    const dedup = new Deduplicator([]);
    dedup.mark("new-hash");
    expect(dedup.isDuplicate("new-hash")).toBe(true);
  });

  it("getHashes returns all seen hashes", () => {
    const dedup = new Deduplicator(["a", "b"]);
    dedup.mark("c");
    const hashes = dedup.getHashes();
    expect(hashes).toContain("a");
    expect(hashes).toContain("b");
    expect(hashes).toContain("c");
    expect(hashes).toHaveLength(3);
  });

  it("handles empty initialization", () => {
    const dedup = new Deduplicator([]);
    expect(dedup.getHashes()).toHaveLength(0);
    expect(dedup.isDuplicate("anything")).toBe(false);
  });
});
