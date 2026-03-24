import { describe, it, expect } from "vitest";
import { computeEventHash, Deduplicator } from "../../../src/cursor/core/sync/deduplicator.js";
import { createUsageEvent } from "../../helpers/fixtures.js";

describe("computeEventHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeEventHash(createUsageEvent());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same event", () => {
    const event = createUsageEvent();
    expect(computeEventHash(event)).toBe(computeEventHash(event));
  });

  it("produces different hashes for different events", () => {
    const h1 = computeEventHash(createUsageEvent({ model: "gpt-4" }));
    const h2 = computeEventHash(createUsageEvent({ model: "claude-3" }));
    expect(h1).not.toBe(h2);
  });

  it("considers timestamp in hash", () => {
    const h1 = computeEventHash(createUsageEvent({ timestamp: 1000 }));
    const h2 = computeEventHash(createUsageEvent({ timestamp: 2000 }));
    expect(h1).not.toBe(h2);
  });

  it("handles missing tokenUsage without crashing", () => {
    const hash = computeEventHash(createUsageEvent({ tokenUsage: undefined }));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for missing vs zero tokenUsage", () => {
    const missingHash = computeEventHash(createUsageEvent({ tokenUsage: undefined }));
    const zeroHash = computeEventHash(
      createUsageEvent({
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCents: 0,
        },
      }),
    );
    expect(missingHash).not.toBe(zeroHash);
  });

  it("considers token counts in hash", () => {
    const h1 = computeEventHash(
      createUsageEvent({
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 10,
          cacheReadTokens: 20,
          totalCents: 5,
        },
      }),
    );
    const h2 = computeEventHash(
      createUsageEvent({
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 50,
          cacheWriteTokens: 10,
          cacheReadTokens: 20,
          totalCents: 5,
        },
      }),
    );
    expect(h1).not.toBe(h2);
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
