import {
  BILLING_PERMISSION_HINT,
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  DEFAULT_LOOKBACK_DAYS,
  ORGANIZATION_UNREACHABLE_HINT,
  SURFACE_MODEL,
  UNKNOWN_EDITOR,
  UNKNOWN_LANGUAGE,
} from "../constants.js";
import {
  applyBillingToBreakdowns,
  createBillingOnlyBreakdowns,
  isCostBearing,
} from "./billing-match.js";
import type {
  CopilotUsageDay,
  CopilotUsageBreakdown,
  CopilotUsageFetch,
  CopilotMetricsReportResponse,
  CopilotSurface,
  CopilotSurfaceTotals,
  CopilotUserDayReport,
  CopilotUserLanguageModel,
  BillingUsageItem,
  BillingUsageResponse,
} from "../types.js";
import {
  getMaxRetries,
  getRequestTimeoutMs,
  isRetryableStatusCode,
  jitteredBackoff,
  retryDelayMs,
  sanitizeErrorMessage,
  sleep,
} from "../../_core/api/resilience.js";
import {
  describeTransportFailure,
  isRetryableTransportError,
} from "../../_core/api/network-error.js";

class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "GithubHttpError";
  }
}

function isGithubStatus(error: unknown, status: number): boolean {
  return error instanceof GithubHttpError && error.status === status;
}

function isRateLimited(response: Response): boolean {
  if (response.status !== 403) return false;
  return (
    response.headers.get("retry-after") !== null ||
    response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function formatDateParam(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function githubRequest<T>(url: string, token: string): Promise<T> {
  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

        const rateLimited = isRateLimited(response);
        const httpError = new GithubHttpError(
          response.status,
          `GitHub API ${response.status} ${response.statusText} - ${sanitized}`,
          rateLimited,
        );

        if ((isRetryableStatusCode(response.status) || rateLimited) && attempt < maxRetries - 1) {
          lastError = httpError;
          await sleep(retryDelayMs(response, attempt));
          continue;
        }

        throw httpError;
      }

      const text = await response.text();
      if (!text || text.trim().length === 0) {
        return null as T;
      }
      return JSON.parse(text) as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof GithubHttpError) {
        throw error;
      }

      if (error instanceof Error) {
        lastError = new Error(describeTransportFailure(error, token, timeoutMs, "GitHub API"));

        if (isRetryableTransportError(error) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
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
  const maxRetries = getMaxRetries();
  const timeoutMs = getRequestTimeoutMs();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const err = new GithubHttpError(
          response.status,
          `NDJSON download failed: ${response.status} ${response.statusText}`,
        );
        if (isRetryableStatusCode(response.status) && attempt < maxRetries - 1) {
          lastError = err;
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw err;
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof GithubHttpError) {
        throw error;
      }

      if (error instanceof Error) {
        lastError = new Error(describeTransportFailure(error, url, timeoutMs, "NDJSON download"));

        if (isRetryableTransportError(error) && attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt));
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

type SurfaceCounts = Pick<
  CopilotUsageBreakdown,
  | "suggestions_count"
  | "acceptances_count"
  | "lines_suggested"
  | "lines_accepted"
  | "input_tokens"
  | "output_tokens"
  | "ai_credits"
>;

const NO_ACTIVITY: SurfaceCounts = {
  suggestions_count: 0,
  acceptances_count: 0,
  lines_suggested: 0,
  lines_accepted: 0,
  input_tokens: 0,
  output_tokens: 0,
  ai_credits: 0,
};

function createSurfaceBreakdown(
  user: CopilotUserDayReport,
  surface: Exclude<CopilotSurface, "billing">,
  counts: SurfaceCounts,
): CopilotUsageBreakdown {
  return {
    ...counts,
    language: UNKNOWN_LANGUAGE,
    editor: UNKNOWN_EDITOR,
    model: SURFACE_MODEL[surface],
    user_login: user.user_login,
    cost_usd: 0,
    active_users: 1,
    surface,
  };
}

function hasReportedActivity(
  totals: CopilotSurfaceTotals | undefined,
): totals is CopilotSurfaceTotals {
  if (!totals) return false;

  return (
    totals.session_count > 0 ||
    totals.request_count > 0 ||
    totals.prompt_count > 0 ||
    (totals.token_usage?.prompt_tokens_sum ?? 0) > 0 ||
    (totals.token_usage?.output_tokens_sum ?? 0) > 0
  );
}

function createSurfaceTotalsBreakdown(
  user: CopilotUserDayReport,
  surface: Exclude<CopilotSurface, "billing">,
  totals: CopilotSurfaceTotals | undefined,
): CopilotUsageBreakdown | null {
  if (!hasReportedActivity(totals)) return null;

  return createSurfaceBreakdown(user, surface, {
    ...NO_ACTIVITY,
    input_tokens: totals.token_usage?.prompt_tokens_sum ?? 0,
    output_tokens: totals.token_usage?.output_tokens_sum ?? 0,
  });
}

function createCompletionBreakdown(user: CopilotUserDayReport): CopilotUsageBreakdown | null {
  const models = user.totals_by_language_model ?? [];
  const residual = (
    total: number | undefined,
    pick: (entry: CopilotUserLanguageModel) => number | undefined,
  ): number =>
    Math.max(0, (total ?? 0) - models.reduce((sum, entry) => sum + (pick(entry) ?? 0), 0));

  const suggestions = residual(
    user.code_generation_activity_count,
    (entry) => entry.code_generation_activity_count,
  );
  if (suggestions === 0) return null;

  const linesSuggested = residual(
    user.loc_suggested_to_add_sum,
    (entry) => entry.loc_suggested_to_add_sum,
  );

  return createSurfaceBreakdown(user, "completion", {
    ...NO_ACTIVITY,
    suggestions_count: suggestions,
    acceptances_count: Math.min(
      suggestions,
      residual(
        user.code_acceptance_activity_count,
        (entry) => entry.code_acceptance_activity_count,
      ),
    ),
    lines_suggested: linesSuggested,
    lines_accepted: Math.min(
      linesSuggested,
      residual(user.loc_added_sum, (entry) => entry.loc_added_sum),
    ),
  });
}

function shareCreditsAcrossRows(
  breakdowns: CopilotUsageBreakdown[],
  credits: number,
): CopilotUsageBreakdown[] {
  if (credits <= 0 || breakdowns.length === 0) return breakdowns;

  const share = credits / breakdowns.length;
  return breakdowns.map((breakdown) => ({ ...breakdown, ai_credits: share }));
}

function createUserBreakdowns(user: CopilotUserDayReport): CopilotUsageBreakdown[] {
  const primaryIde = user.totals_by_ide?.[0]?.ide ?? UNKNOWN_EDITOR;

  const breakdowns: CopilotUsageBreakdown[] = (user.totals_by_language_model ?? []).map(
    (entry) => ({
      language: entry.language,
      editor: primaryIde,
      model: entry.model,
      user_login: user.user_login,
      cost_usd: 0,
      suggestions_count: entry.code_generation_activity_count ?? 0,
      acceptances_count: entry.code_acceptance_activity_count ?? 0,
      lines_suggested: entry.loc_suggested_to_add_sum ?? 0,
      lines_accepted: entry.loc_added_sum ?? 0,
      active_users: 1,
      input_tokens: 0,
      output_tokens: 0,
      ai_credits: 0,
    }),
  );

  const surfaceRows = [
    createSurfaceTotalsBreakdown(user, "cli", user.totals_by_cli),
    createSurfaceTotalsBreakdown(user, "app", user.totals_by_copilot_app),
    createCompletionBreakdown(user),
  ].filter((row): row is CopilotUsageBreakdown => row !== null);

  const credits = user.ai_credits_used ?? 0;
  const rows = [...breakdowns, ...surfaceRows];
  if (rows.length === 0 && credits > 0) {
    rows.push(createSurfaceBreakdown(user, "credit", NO_ACTIVITY));
  }

  return shareCreditsAcrossRows(rows, credits);
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
    if (user.used_chat || user.used_agent) {
      chatUsers++;
      totalChatTurns += user.user_initiated_interaction_count ?? 0;
    }

    totalSuggestions += user.code_generation_activity_count ?? 0;
    totalAcceptances += user.code_acceptance_activity_count ?? 0;
    totalLinesSuggested += user.loc_suggested_to_add_sum ?? 0;
    totalLinesAccepted += user.loc_added_sum ?? 0;

    breakdowns.push(...createUserBreakdowns(user));
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

interface BillingFetch {
  items: BillingUsageItem[];
  failure?: string;
}

function describeBillingFailure(error: unknown): string {
  if (error instanceof GithubHttpError) {
    const needsPermissionHint =
      !error.rateLimited && (error.status === 401 || error.status === 403);
    return needsPermissionHint ? `${error.message} ${BILLING_PERMISSION_HINT}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function fetchBillingForDay(token: string, org: string, date: Date): Promise<BillingFetch> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/settings/billing/ai_credit/usage?year=${year}&month=${month}&day=${day}`;

  try {
    const response = await githubRequest<BillingUsageResponse | null>(url, token);
    if (!Array.isArray(response?.usageItems)) {
      return { items: [], failure: "GitHub returned no usageItems array" };
    }
    return { items: response.usageItems };
  } catch (error) {
    if (isGithubStatus(error, 404)) return { items: [] };
    return { items: [], failure: describeBillingFailure(error) };
  }
}

function metricsReportUrl(org: string, day: string): string {
  return `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${day}`;
}

async function fetchUserReportsForDay(
  token: string,
  org: string,
  day: string,
): Promise<CopilotUserDayReport[]> {
  try {
    const report = await githubRequest<CopilotMetricsReportResponse | null>(
      metricsReportUrl(org, day),
      token,
    );
    const users: CopilotUserDayReport[] = [];

    for (const link of report?.download_links ?? []) {
      const ndjsonText = await downloadNdjson(link);
      users.push(...parseNdjson<CopilotUserDayReport>(ndjsonText));
    }

    return users;
  } catch (error) {
    if (isGithubStatus(error, 404)) return [];
    throw error;
  }
}

function withholdCostBearingRows(usageDay: CopilotUsageDay): void {
  usageDay.breakdown = usageDay.breakdown.filter((breakdown) => !isCostBearing(breakdown));
}

function buildUsageFetch(
  usageDay: CopilotUsageDay,
  userCount: number,
  billing: BillingFetch,
  allowMissingBilling: boolean,
): CopilotUsageFetch {
  if (billing.failure) {
    const costBearingRecords = usageDay.breakdown.filter(isCostBearing).length;
    if (!allowMissingBilling) withholdCostBearingRows(usageDay);

    return {
      days: usageDay.breakdown.length > 0 ? [usageDay] : [],
      unmatchedBilling: [],
      billingUnavailable: [
        {
          day: usageDay.day,
          reason: billing.failure,
          withheldRecords: allowMissingBilling ? 0 : costBearingRecords,
          zeroCostRecords: allowMissingBilling ? costBearingRecords : 0,
          unresolved: !allowMissingBilling,
        },
      ],
    };
  }

  const unmatchedBilling = applyBillingToBreakdowns(
    usageDay.breakdown,
    billing.items,
    usageDay.day,
  );
  usageDay.breakdown.push(...createBillingOnlyBreakdowns(unmatchedBilling));

  return {
    days: userCount > 0 || unmatchedBilling.length > 0 ? [usageDay] : [],
    unmatchedBilling,
    billingUnavailable: [],
  };
}

export interface UsageFetchOptions {
  allowMissingBilling?: boolean;
}

export class OrganizationUnreachableError extends Error {
  constructor(readonly org: string) {
    super(
      `GitHub organization "${org}" could not be reached with this token. ${ORGANIZATION_UNREACHABLE_HINT}`,
    );
    this.name = "OrganizationUnreachableError";
  }
}

async function assertOrganizationReachable(token: string, org: string): Promise<void> {
  const url = `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}`;

  try {
    await githubRequest<unknown>(url, token);
  } catch (error) {
    if (!isGithubStatus(error, 404)) throw error;

    throw new OrganizationUnreachableError(org);
  }
}

export async function* fetchUsageDays(
  token: string,
  org: string,
  since?: string,
  until?: string,
  options: UsageFetchOptions = {},
): AsyncGenerator<CopilotUsageFetch> {
  const { allowMissingBilling = false } = options;
  const now = new Date();
  const defaultSince = new Date(now);
  defaultSince.setDate(defaultSince.getDate() - DEFAULT_LOOKBACK_DAYS);

  const sinceDate = since ? new Date(since) : defaultSince;
  const untilDate = until ? new Date(until) : now;

  const current = new Date(sinceDate);

  await assertOrganizationReachable(token, org);

  while (current <= untilDate) {
    const dayParam = formatDateParam(current);

    const users = await fetchUserReportsForDay(token, org, dayParam);
    const billing = await fetchBillingForDay(token, org, current);
    const usageDay = convertUserReportToUsageDay(dayParam, users);

    yield buildUsageFetch(usageDay, users.length, billing, allowMissingBilling);

    current.setDate(current.getDate() + 1);
  }
}

export type CopilotAccess =
  | { status: "connected" }
  | { status: "metrics-unreadable" }
  | { status: "organization-unreachable" }
  | { status: "failed"; message: string };

function describeAccessFailure(error: unknown, token: string): CopilotAccess {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", message: sanitizeErrorMessage(message, token) };
}

function isCredentialRejected(error: unknown): boolean {
  return isGithubStatus(error, 401) || isGithubStatus(error, 403);
}

async function checkMetricsAccess(token: string, org: string): Promise<CopilotAccess> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  try {
    await githubRequest<CopilotMetricsReportResponse | null>(
      metricsReportUrl(org, formatDateParam(yesterday)),
      token,
    );
    return { status: "connected" };
  } catch (error) {
    if (isGithubStatus(error, 404)) return { status: "connected" };
    if (isCredentialRejected(error)) return { status: "metrics-unreadable" };
    return describeAccessFailure(error, token);
  }
}

export async function checkCopilotAccess(token: string, org: string): Promise<CopilotAccess> {
  try {
    await assertOrganizationReachable(token, org);
  } catch (error) {
    if (error instanceof OrganizationUnreachableError)
      return { status: "organization-unreachable" };
    if (isCredentialRejected(error)) return { status: "metrics-unreadable" };
    return describeAccessFailure(error, token);
  }

  return checkMetricsAccess(token, org);
}
