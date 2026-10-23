import { describe, it, expect } from "vitest";
import { Deduplicator } from "../../../src/_core/sync/deduplicator.js";

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

  it("handles empty initialization", () => {
    const dedup = new Deduplicator([]);
    expect(dedup.isDuplicate("anything")).toBe(false);
  });

  it("evicts the oldest hash once the recent window is full", () => {
    const dedup = new Deduplicator([], 2);

    dedup.mark("first");
    dedup.mark("second");
    dedup.mark("third");

    expect(dedup.isDuplicate("first")).toBe(false);
    expect(dedup.isDuplicate("second")).toBe(true);
    expect(dedup.isDuplicate("third")).toBe(true);
  });
});
