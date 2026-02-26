import { createHash } from "node:crypto";
import type { CursorUsageEvent } from "../../types.js";

export function computeEventHash(event: CursorUsageEvent): string {
  const raw = JSON.stringify({
    ts: event.timestamp,
    u: event.userEmail,
    m: event.model,
    k: event.kind,
    it: event.tokenUsage.inputTokens,
    ot: event.tokenUsage.outputTokens,
    crt: event.tokenUsage.cacheReadTokens,
    cwt: event.tokenUsage.cacheWriteTokens,
    tc: event.tokenUsage.totalCents,
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
