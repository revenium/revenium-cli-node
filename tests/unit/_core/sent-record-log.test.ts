import { describe, it, expect } from "vitest";
import {
  SentRecordLog,
  countSentRecords,
  parseSentRecords,
  utcDayKey,
} from "../../../src/_core/sync/sent-record-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_ONE = new Date("2026-06-01").getTime();

function hash(day: number, index: number): string {
  return `day-${day}-record-${String(index).padStart(8, "0")}`.padEnd(64, "0");
}

describe("SentRecordLog", () => {
  it("remembers every fingerprint it is given, with no count cap", () => {
    const log = new SentRecordLog({});

    for (let index = 0; index < 25_000; index++) {
      log.mark(hash(0, index), DAY_ONE);
    }

    expect(log.size()).toBe(25_000);
    expect(log.isDuplicate(hash(0, 0))).toBe(true);
    expect(log.isDuplicate(hash(0, 24_999))).toBe(true);
    expect(log.isDuplicate(hash(0, 25_000))).toBe(false);
  });

  it("drops only buckets strictly before the floor day", () => {
    const log = new SentRecordLog({});

    for (let day = 0; day < 3; day++) {
      for (let index = 0; index < 8_000; index++) {
        log.mark(hash(day, index), DAY_ONE + day * DAY_MS);
      }
    }

    log.pruneOutside(utcDayKey(DAY_ONE + DAY_MS), utcDayKey(DAY_ONE + 2 * DAY_MS));

    expect(Object.keys(log.toState())).toEqual(["2026-06-02", "2026-06-03"]);
    expect(log.size()).toBe(16_000);
    expect(log.isDuplicate(hash(1, 0))).toBe(true);
    expect(log.isDuplicate(hash(0, 0))).toBe(false);
  });

  it("drops buckets dated after the ceiling day", () => {
    const log = new SentRecordLog({});

    log.mark(hash(0, 0), DAY_ONE);
    log.mark(hash(1, 0), new Date("2030-01-01").getTime());

    log.pruneOutside(utcDayKey(DAY_ONE), utcDayKey(DAY_ONE));

    expect(Object.keys(log.toState())).toEqual(["2026-06-01"]);
  });

  it("round-trips its buckets through state", () => {
    const log = new SentRecordLog({ "2026-06-01": ["a"], "2026-06-02": ["b", "c"] });

    expect(log.toState()).toEqual({ "2026-06-01": ["a"], "2026-06-02": ["b", "c"] });
    expect(log.size()).toBe(3);
  });
});

describe("countSentRecords", () => {
  it("totals the fingerprints across every day bucket", () => {
    expect(countSentRecords({ "2026-06-01": ["a"], "2026-06-02": ["b", "c"] })).toBe(3);
    expect(countSentRecords({})).toBe(0);
  });
});

describe("parseSentRecords", () => {
  it("accepts a map of day keys to fingerprint lists", () => {
    expect(parseSentRecords({ "2026-06-01": ["a", "b"] })).toEqual({ "2026-06-01": ["a", "b"] });
  });

  it("rejects anything that is not such a map", () => {
    expect(parseSentRecords(["a"])).toEqual({});
    expect(parseSentRecords("a")).toEqual({});
    expect(parseSentRecords(null)).toEqual({});
    expect(parseSentRecords(undefined)).toEqual({});
    expect(parseSentRecords({ "2026-06-01": "a" })).toEqual({});
    expect(parseSentRecords({ "2026-06-01": [1, 2] })).toEqual({});
  });
});

describe("utcDayKey", () => {
  it("formats a timestamp as its UTC day", () => {
    expect(utcDayKey(DAY_ONE)).toBe("2026-06-01");
    expect(utcDayKey(DAY_ONE + DAY_MS - 1)).toBe("2026-06-01");
    expect(utcDayKey(DAY_ONE + DAY_MS)).toBe("2026-06-02");
  });
});
