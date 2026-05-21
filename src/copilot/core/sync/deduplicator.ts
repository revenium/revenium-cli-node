import { createHash } from "node:crypto";
import type { CopilotUsageDay, CopilotUsageBreakdown } from "../../types.js";

export function computeBreakdownHash(
  day: CopilotUsageDay,
  breakdown: CopilotUsageBreakdown,
): string {
  const raw = JSON.stringify({
    d: day.day,
    l: breakdown.language,
    e: breakdown.editor,
  });

  return createHash("sha256").update(raw).digest("hex");
}

export class Deduplicator {
  private seen: Set<string>;

  constructor(existingHashes: string[]) {
    this.seen = new Set(existingHashes);
  }

  isDuplicate(hash: string): boolean {
    return this.seen.has(hash);
  }

  mark(hash: string): void {
    this.seen.add(hash);
  }

  getHashes(): string[] {
    return Array.from(this.seen);
  }
}
