import type { CursorConfig, CursorUsageEvent, SyncState } from "../../src/cursor/types.js";

export function createCursorConfig(overrides: Partial<CursorConfig> = {}): CursorConfig {
  return {
    cursorApiKey: "cursor_key_12345",
    reveniumApiKey: "hak_tenant_abc123xyz",
    reveniumEndpoint: "https://api.revenium.ai",
    syncIntervalMs: 300000,
    ...overrides,
  };
}

export function createUsageEvent(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    timestamp: 1700000000000,
    model: "claude-3.5-sonnet",
    kind: "Usage-based",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 10,
      cacheReadTokens: 20,
      totalCents: 5,
    },
    cursorTokenFee: 0.01,
    requestsCosts: 0.05,
    isTokenBasedCall: true,
    userEmail: "dev@company.com",
    maxMode: false,
    isChargeable: true,
    isHeadless: false,
    ...overrides,
  };
}

export function createSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    lastSyncTimestamp: 0,
    lastSyncEventCount: 0,
    totalEventsSynced: 0,
    recentHashes: [],
    ...overrides,
  };
}
