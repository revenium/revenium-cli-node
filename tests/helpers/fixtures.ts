import type { CursorConfig, CursorUsageEvent, SyncState } from "../../src/cursor/types.js";
import type {
  CopilotConfig,
  CopilotUsageDay,
  CopilotUsageBreakdown,
  SyncState as CopilotSyncState,
} from "../../src/copilot/types.js";

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
    userEmail: "dev@company.com",
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

export function createCopilotConfig(overrides: Partial<CopilotConfig> = {}): CopilotConfig {
  return {
    githubToken: "ghp_test1234567890abcdef",
    githubOrg: "test-org",
    reveniumApiKey: "hak_tenant_abc123xyz",
    reveniumEndpoint: "https://api.revenium.ai",
    syncIntervalMs: 300000,
    ...overrides,
  };
}

export function createCopilotBreakdown(
  overrides: Partial<CopilotUsageBreakdown> = {},
): CopilotUsageBreakdown {
  return {
    language: "typescript",
    editor: "vscode",
    model: "gpt-4o",
    user_login: "testuser",
    cost_usd: 0,
    suggestions_count: 150,
    acceptances_count: 90,
    lines_suggested: 300,
    lines_accepted: 180,
    active_users: 5,
    ...overrides,
  };
}

export function createCopilotUsageDay(overrides: Partial<CopilotUsageDay> = {}): CopilotUsageDay {
  return {
    day: "2024-06-15",
    total_suggestions_count: 150,
    total_acceptances_count: 90,
    total_lines_suggested: 300,
    total_lines_accepted: 180,
    total_active_users: 5,
    total_chat_acceptances: 10,
    total_chat_turns: 25,
    total_active_chat_users: 3,
    breakdown: [createCopilotBreakdown()],
    ...overrides,
  };
}

export function createCopilotSyncState(
  overrides: Partial<CopilotSyncState> = {},
): CopilotSyncState {
  return {
    lastSyncTimestamp: 0,
    lastSyncEventCount: 0,
    totalEventsSynced: 0,
    recentHashes: [],
    ...overrides,
  };
}
