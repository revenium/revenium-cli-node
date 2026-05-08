import type { SubscriptionTier } from "./constants.js";

export interface CursorConfig {
  cursorApiKey: string;
  reveniumApiKey: string;
  reveniumEndpoint: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  syncIntervalMs: number;
  subscriptionTier?: SubscriptionTier;
}

export interface CursorUsageEvent {
  timestamp: number;
  model: string;
  kind: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalCents: number;
  } | null;
  userEmail: string;
}

export interface CursorPaginatedResponse {
  totalUsageEventsCount: number;
  pagination: {
    numPages: number;
    currentPage: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  usageEvents: CursorUsageEvent[];
}

export interface SyncState {
  lastSyncTimestamp: number;
  lastSyncEventCount: number;
  totalEventsSynced: number;
  recentHashes: string[];
}

export interface SyncResult {
  fetched: number;
  sent: number;
  duplicatesSkipped: number;
  invalidTimestampsSkipped: number;
  errors: number;
}
