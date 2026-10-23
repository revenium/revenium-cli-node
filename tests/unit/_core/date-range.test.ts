import { describe, it, expect } from "vitest";
import { toInclusiveRangeEnd } from "../../../src/_core/utils/date-range.js";

describe("toInclusiveRangeEnd", () => {
  it("extends a date-only end to the last millisecond of that UTC day", () => {
    const end = toInclusiveRangeEnd("2026-09-30", new Date("2026-09-30"));

    expect(end.getTime()).toBe(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
  });

  it("keeps an end carrying an explicit time at that exact instant", () => {
    const parsed = new Date("2026-09-30T12:00:00Z");

    expect(toInclusiveRangeEnd("2026-09-30T12:00:00Z", parsed).getTime()).toBe(parsed.getTime());
  });

  it("keeps an instant derived from a relative input unchanged", () => {
    const parsed = new Date("2026-10-13T08:30:00Z");

    expect(toInclusiveRangeEnd("7d", parsed).getTime()).toBe(parsed.getTime());
  });
});
