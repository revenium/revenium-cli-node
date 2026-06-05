import { GITHUB_API_BASE_URL, GITHUB_API_VERSION, DEFAULT_LOOKBACK_DAYS } from "../constants.js";
import type {
  CopilotUsageDay,
  CopilotUsageBreakdown,
  CopilotMetricsReportResponse,
  CopilotUserDayReport,
  BillingUsageResponse,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

function isRetryableStatusCode(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryableError(error: Error): boolean {
  return (
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message: string, token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedToken, "g"), "***");
}

function parseRetryAfter(header: string | null, attempt: number): number {
  const fallback = RETRY_DELAY_MS * (attempt + 1);
  if (!header) return fallback;

  const seconds = parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.max(date.getTime() - Date.now(), 0);
  }

  return fallback;
}

function formatDateParam(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function githubRequest<T>(url: string, token: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        const sanitized = sanitizeErrorMessage(errorText, token);

        if (isRetryableStatusCode(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(
            `GitHub API ${response.status} ${response.statusText} - ${sanitized}`,
          );

          if (response.status === 429) {
            await sleep(parseRetryAfter(response.headers.get("retry-after"), attempt));
          } else {
            await sleep(RETRY_DELAY_MS * (attempt + 1));
          }
          continue;
        }

        throw new Error(`GitHub API ${response.status} ${response.statusText} - ${sanitized}`);
      }

      const text = await response.text();
      if (!text || text.trim().length === 0) {
        return null as T;
      }
      return JSON.parse(text) as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`GitHub API request timeout after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
          lastError = new Error(sanitizeErrorMessage(error.message, token));
        }

        if (isRetryableError(lastError) && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }

        throw lastError;
      }
      throw error;
    }
  }

  throw lastError || new Error("GitHub API request failed after retries");
}

async function downloadNdjson(url: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const err = new Error(`NDJSON download failed: ${response.status} ${response.statusText}`);
        if (isRetryableStatusCode(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = err;
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`NDJSON download timeout after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
          lastError = error;
        }
        if (isRetryableError(lastError) && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      throw error;
    }
  }

  throw lastError || new Error("NDJSON download failed after retries");
}

function parseNdjson<T>(text: string): T[] {
  const results: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return results;
}

export function convertUserReportToUsageDay(
  day: string,
  users: CopilotUserDayReport[],
): CopilotUsageDay {
  const breakdowns: CopilotUsageBreakdown[] = [];
  let totalSuggestions = 0;
  let totalAcceptances = 0;
  let totalLinesSuggested = 0;
  let totalLinesAccepted = 0;
  let totalChatTurns = 0;
  let chatUsers = 0;

  for (const user of users) {
    const primaryIde = user.totals_by_ide?.[0]?.ide ?? "unknown";

    if (user.used_chat || user.used_agent) {
      chatUsers++;
      totalChatTurns += user.user_initiated_interaction_count;
    }

    for (const entry of user.totals_by_language_model ?? []) {
      totalSuggestions += entry.code_generation_activity_count;
      totalAcceptances += entry.code_acceptance_activity_count;
      totalLinesSuggested += entry.loc_suggested_to_add_sum;
      totalLinesAccepted += entry.loc_added_sum;

      breakdowns.push({
        language: entry.language,
        editor: primaryIde,
        model: entry.model,
        user_login: user.user_login,
        cost_usd: 0,
        suggestions_count: entry.code_generation_activity_count,
        acceptances_count: entry.code_acceptance_activity_count,
        lines_suggested: entry.loc_suggested_to_add_sum,
        lines_accepted: entry.loc_added_sum,
        active_users: 1,
      });
    }
  }

  return {
    day,
    total_suggestions_count: totalSuggestions,
    total_acceptances_count: totalAcceptances,
    total_lines_suggested: totalLinesSuggested,
    total_lines_accepted: totalLinesAccepted,
    total_active_users: users.length,
    total_chat_acceptances: 0,
    total_chat_turns: totalChatTurns,
    total_active_chat_users: chatUsers,
    breakdown: breakdowns,
  };
}

async function fetchBillingForDay(
  token: string,
  org: string,
  date: Date,
): Promise<Map<string, number>> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/settings/billing/ai_credit/usage?year=${year}&month=${month}&day=${day}`;

  try {
    const response = await githubRequest<BillingUsageResponse | null>(url, token);
    const costByModel = new Map<string, number>();

    if (response?.usageItems) {
      for (const item of response.usageItems) {
        const normalizedModel = item.model.replace(/^Auto:\s*/i, "").toLowerCase();
        const existing = costByModel.get(normalizedModel) ?? 0;
        costByModel.set(normalizedModel, existing + item.grossAmount);
      }
    }

    return costByModel;
  } catch {
    return new Map();
  }
}

function enrichBreakdownsWithCost(
  breakdowns: CopilotUsageBreakdown[],
  costByModel: Map<string, number>,
): void {
  const countPerModel = new Map<string, number>();
  for (const b of breakdowns) {
    const key = b.model.toLowerCase();
    countPerModel.set(key, (countPerModel.get(key) ?? 0) + 1);
  }

  for (const b of breakdowns) {
    const key = b.model.toLowerCase();
    const totalCost = costByModel.get(key) ?? 0;
    const count = countPerModel.get(key) ?? 1;
    b.cost_usd = totalCost / count;
  }
}

export async function* fetchUsageDays(
  token: string,
  org: string,
  since?: string,
  until?: string,
): AsyncGenerator<CopilotUsageDay[]> {
  const now = new Date();
  const defaultSince = new Date(now);
  defaultSince.setDate(defaultSince.getDate() - DEFAULT_LOOKBACK_DAYS);

  const sinceDate = since ? new Date(since) : defaultSince;
  const untilDate = until ? new Date(until) : now;

  const current = new Date(sinceDate);

  while (current <= untilDate) {
    const dayParam = formatDateParam(current);

    const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${dayParam}`;

    try {
      const report = await githubRequest<CopilotMetricsReportResponse | null>(url, token);

      if (report?.download_links && report.download_links.length > 0) {
        const allUsers: CopilotUserDayReport[] = [];

        for (const link of report.download_links) {
          const ndjsonText = await downloadNdjson(link);
          const users = parseNdjson<CopilotUserDayReport>(ndjsonText);
          allUsers.push(...users);
        }

        if (allUsers.length > 0) {
          const usageDay = convertUserReportToUsageDay(dayParam, allUsers);
          const costByModel = await fetchBillingForDay(token, org, current);
          enrichBreakdownsWithCost(usageDay.breakdown, costByModel);
          yield [usageDay];
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        current.setDate(current.getDate() + 1);
        continue;
      }
      throw error;
    }

    current.setDate(current.getDate() + 1);
  }
}

export async function testConnectivity(token: string, org: string): Promise<boolean> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${formatDateParam(yesterday)}`;

  try {
    await githubRequest<CopilotMetricsReportResponse>(url, token);
    return true;
  } catch {
    return false;
  }
}
