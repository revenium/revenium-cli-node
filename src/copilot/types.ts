import type { SubscriptionTier } from "./constants.js";

export interface CopilotConfig {
  githubToken: string;
  githubOrg: string;
  reveniumApiKey: string;
  reveniumEndpoint: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  syncIntervalMs: number;
  subscriptionTier?: SubscriptionTier;
}

export interface CopilotUsageBreakdown {
  language: string;
  editor: string;
  suggestions_count: number;
  acceptances_count: number;
  lines_suggested: number;
  lines_accepted: number;
  active_users: number;
}

export interface CopilotUsageDay {
  day: string;
  total_suggestions_count: number;
  total_acceptances_count: number;
  total_lines_suggested: number;
  total_lines_accepted: number;
  total_active_users: number;
  total_chat_acceptances: number;
  total_chat_turns: number;
  total_active_chat_users: number;
  breakdown: CopilotUsageBreakdown[];
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
  errors: number;
}
