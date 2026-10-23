const PERSISTED_FINGERPRINT_LENGTH = 32;

function toFingerprint(hash: string): string {
  return hash.slice(0, PERSISTED_FINGERPRINT_LENGTH);
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseSentRecords(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const buckets: Record<string, string[]> = {};

  for (const [day, fingerprints] of Object.entries(value)) {
    if (!Array.isArray(fingerprints)) return {};
    if (fingerprints.some((fingerprint) => typeof fingerprint !== "string")) return {};
    buckets[day] = fingerprints as string[];
  }

  return buckets;
}

export function countSentRecords(records: Record<string, string[]>): number {
  return Object.values(records).reduce((total, fingerprints) => total + fingerprints.length, 0);
}

export class SentRecordLog {
  private readonly buckets = new Map<string, Set<string>>();

  constructor(buckets: Record<string, string[]>) {
    for (const [day, fingerprints] of Object.entries(buckets)) {
      this.buckets.set(day, new Set(fingerprints));
    }
  }

  isDuplicate(hash: string): boolean {
    const fingerprint = toFingerprint(hash);

    for (const bucket of this.buckets.values()) {
      if (bucket.has(fingerprint)) return true;
    }

    return false;
  }

  mark(hash: string, timestampMs: number): void {
    const day = utcDayKey(timestampMs);
    const bucket = this.buckets.get(day) ?? new Set<string>();

    bucket.add(toFingerprint(hash));
    this.buckets.set(day, bucket);
  }

  pruneOutside(floorDay: string, ceilingDay: string): void {
    for (const day of this.buckets.keys()) {
      if (day < floorDay || day > ceilingDay) this.buckets.delete(day);
    }
  }

  toState(): Record<string, string[]> {
    const state: Record<string, string[]> = {};

    for (const [day, bucket] of this.buckets) {
      state[day] = [...bucket];
    }

    return state;
  }

  size(): number {
    let total = 0;

    for (const bucket of this.buckets.values()) {
      total += bucket.size;
    }

    return total;
  }
}
