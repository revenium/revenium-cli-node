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
  model: string;
  user_login: string;
  cost_usd: number;
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

export interface CopilotMetricsReportResponse {
  download_links: string[];
  report_day: string;
}

export interface CopilotUserLanguageFeature {
  language: string;
  feature: string;
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
}

export interface CopilotUserIdeTotal {
  ide: string;
  user_initiated_interaction_count: number;
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
}

export interface CopilotUserDayReport {
  user_id: number;
  user_login: string;
  day: string;
  organization_id: string;
  user_initiated_interaction_count: number;
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
  used_chat: boolean;
  used_agent: boolean;
  used_cli: boolean;
  totals_by_ide: CopilotUserIdeTotal[];
  totals_by_language_feature: CopilotUserLanguageFeature[];
  totals_by_language_model: CopilotUserLanguageModel[];
}

export interface CopilotUserLanguageModel {
  language: string;
  model: string;
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
}

export interface BillingUsageItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

export interface BillingUsageResponse {
  timePeriod: { year: number; month: number; day: number };
  organization: string;
  usageItems: BillingUsageItem[];
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
