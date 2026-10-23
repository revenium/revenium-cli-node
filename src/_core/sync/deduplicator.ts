export class Deduplicator {
  private seen: Set<string>;

  constructor(
    existingHashes: string[],
    private readonly recentWindowSize?: number,
  ) {
    this.seen = new Set(existingHashes);
  }

  isDuplicate(hash: string): boolean {
    return this.seen.has(hash);
  }

  mark(hash: string): void {
    this.seen.add(hash);

    if (this.recentWindowSize !== undefined && this.seen.size > this.recentWindowSize) {
      this.forgetOldestHash();
    }
  }

  private forgetOldestHash(): void {
    const oldest = this.seen.values().next().value;
    if (oldest !== undefined) {
      this.seen.delete(oldest);
    }
  }
}
