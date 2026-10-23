import { describe, it, expect, afterEach, vi } from "vitest";
import {
  convertUserReportToUsageDay,
  fetchUsageDays,
  checkCopilotAccess,
} from "../../../src/copilot/core/github-client.js";
import { applyBillingToBreakdowns } from "../../../src/copilot/core/billing-match.js";
import { createBillingUsageItem } from "../../helpers/fixtures.js";
import { GITHUB_API_BASE_URL } from "../../../src/copilot/constants.js";
import type { CopilotUsageFetch, CopilotUserDayReport } from "../../../src/copilot/types.js";

function createUserReport(overrides: Partial<CopilotUserDayReport> = {}): CopilotUserDayReport {
  return {
    user_id: 1,
    user_login: "testuser",
    day: "2026-06-03",
    organization_id: "12345",
    user_initiated_interaction_count: 5,
    code_generation_activity_count: 2,
    code_acceptance_activity_count: 1,
    loc_suggested_to_add_sum: 10,
    loc_suggested_to_delete_sum: 0,
    loc_added_sum: 8,
    loc_deleted_sum: 0,
    used_chat: false,
    used_agent: false,
    used_cli: false,
    ai_credits_used: 0,
    totals_by_ide: [
      {
        ide: "vscode",
        user_initiated_interaction_count: 5,
        code_generation_activity_count: 2,
        code_acceptance_activity_count: 1,
        loc_suggested_to_add_sum: 10,
        loc_suggested_to_delete_sum: 0,
        loc_added_sum: 8,
        loc_deleted_sum: 0,
      },
    ],
    totals_by_language_feature: [],
    totals_by_language_model: [
      {
        language: "typescript",
        model: "gpt-4o",
        code_generation_activity_count: 2,
        code_acceptance_activity_count: 1,
        loc_suggested_to_add_sum: 10,
        loc_suggested_to_delete_sum: 0,
        loc_added_sum: 8,
        loc_deleted_sum: 0,
      },
    ],
    ...overrides,
  };
}

describe("convertUserReportToUsageDay", () => {
  it("converts a single user report to CopilotUsageDay", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [createUserReport()]);

    expect(result.day).toBe("2026-06-03");
    expect(result.total_active_users).toBe(1);
    expect(result.total_suggestions_count).toBe(2);
    expect(result.total_acceptances_count).toBe(1);
    expect(result.total_lines_suggested).toBe(10);
    expect(result.total_lines_accepted).toBe(8);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].language).toBe("typescript");
    expect(result.breakdown[0].editor).toBe("vscode");
    expect(result.breakdown[0].model).toBe("gpt-4o");
    expect(result.breakdown[0].user_login).toBe("testuser");
  });

  it("aggregates multiple users into one day", () => {
    const user1 = createUserReport({ user_login: "alice" });
    const user2 = createUserReport({
      user_id: 2,
      user_login: "bob",
      code_generation_activity_count: 5,
      code_acceptance_activity_count: 3,
      loc_suggested_to_add_sum: 20,
      loc_added_sum: 15,
      totals_by_language_model: [
        {
          language: "python",
          model: "gpt-4o",
          code_generation_activity_count: 5,
          code_acceptance_activity_count: 3,
          loc_suggested_to_add_sum: 20,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 15,
          loc_deleted_sum: 0,
        },
      ],
    });

    const result = convertUserReportToUsageDay("2026-06-03", [user1, user2]);

    expect(result.total_active_users).toBe(2);
    expect(result.total_suggestions_count).toBe(7);
    expect(result.total_acceptances_count).toBe(4);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown[0].user_login).toBe("alice");
    expect(result.breakdown[1].user_login).toBe("bob");
  });

  it("counts chat users from used_chat and used_agent flags", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({ used_chat: true, user_initiated_interaction_count: 10 }),
    ]);

    expect(result.total_active_chat_users).toBe(1);
    expect(result.total_chat_turns).toBe(10);
  });

  it("imports completion activity absent from the language_model breakdown", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({ totals_by_language_model: [] }),
    ]);

    expect(result.total_active_users).toBe(1);
    expect(result.total_suggestions_count).toBe(2);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].surface).toBe("completion");
    expect(result.breakdown[0].suggestions_count).toBe(2);
    expect(result.breakdown[0].lines_accepted).toBe(8);
  });

  it("emits no row for a developer with no activity and no credits", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        totals_by_language_model: [],
        code_generation_activity_count: 0,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 0,
        loc_added_sum: 0,
      }),
    ]);

    expect(result.breakdown).toHaveLength(0);
  });

  it("clamps residual completion activity when the chat breakdown exceeds the day totals", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        code_generation_activity_count: 1,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 0,
        loc_added_sum: 0,
      }),
    ]);

    expect(result.breakdown.some((row) => row.surface === "completion")).toBe(false);
  });

  it("yields CLI, app and completion rows for a developer with no chat breakdown", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        code_generation_activity_count: 3,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 0,
        loc_added_sum: 0,
        ai_credits_used: 12.5,
        totals_by_language_model: [],
        totals_by_cli: {
          session_count: 2,
          request_count: 9,
          prompt_count: 9,
          token_usage: { prompt_tokens_sum: 8000, output_tokens_sum: 800 },
        },
        totals_by_copilot_app: {
          session_count: 1,
          request_count: 4,
          prompt_count: 4,
          token_usage: { prompt_tokens_sum: 9000, output_tokens_sum: 600 },
        },
      }),
    ]);

    expect(result.breakdown).toHaveLength(3);
    expect(result.breakdown.map((row) => row.surface)).toEqual(["cli", "app", "completion"]);

    const tokens = result.breakdown.reduce(
      (sum, row) => sum + row.input_tokens + row.output_tokens,
      0,
    );
    expect(tokens).toBe(18400);
    expect(result.breakdown.reduce((sum, row) => sum + row.ai_credits, 0)).toBeCloseTo(12.5);
    expect(result.breakdown.every((row) => row.ai_credits > 0)).toBe(true);
  });

  it("emits no completion row when every suggestion is already attributed to a model row", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        code_generation_activity_count: 10,
        code_acceptance_activity_count: 10,
        loc_suggested_to_add_sum: 100,
        loc_added_sum: 80,
        totals_by_language_model: [
          {
            language: "typescript",
            model: "gpt-4o",
            code_generation_activity_count: 10,
            code_acceptance_activity_count: 4,
            loc_suggested_to_add_sum: 100,
            loc_suggested_to_delete_sum: 0,
            loc_added_sum: 10,
            loc_deleted_sum: 0,
          },
        ],
      }),
    ]);

    expect(result.breakdown.some((row) => row.surface === "completion")).toBe(false);
  });

  it("caps a completion row's acceptances and accepted lines at what it suggested", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        code_generation_activity_count: 10,
        code_acceptance_activity_count: 10,
        loc_suggested_to_add_sum: 100,
        loc_added_sum: 100,
        totals_by_language_model: [
          {
            language: "typescript",
            model: "gpt-4o",
            code_generation_activity_count: 4,
            code_acceptance_activity_count: 1,
            loc_suggested_to_add_sum: 40,
            loc_suggested_to_delete_sum: 0,
            loc_added_sum: 5,
            loc_deleted_sum: 0,
          },
        ],
      }),
    ]);

    const completion = result.breakdown.find((row) => row.surface === "completion");

    expect(completion?.suggestions_count).toBe(6);
    expect(completion?.acceptances_count).toBe(6);
    expect(completion?.lines_suggested).toBe(60);
    expect(completion?.lines_accepted).toBe(60);
  });

  it("emits no surface row for a developer whose CLI totals report nothing", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        totals_by_cli: {
          session_count: 0,
          request_count: 0,
          prompt_count: 0,
          token_usage: { prompt_tokens_sum: 0, output_tokens_sum: 0 },
        },
      }),
    ]);

    expect(result.breakdown.some((row) => row.surface === "cli")).toBe(false);
  });

  it("keeps the credits of a CLI developer whose totals omit the token usage block", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        user_login: "bob",
        used_cli: true,
        code_generation_activity_count: 0,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 0,
        loc_added_sum: 0,
        totals_by_language_model: [],
        ai_credits_used: 7.5,
        totals_by_cli: { session_count: 3, request_count: 12, prompt_count: 12 },
      }),
    ]);

    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].surface).toBe("cli");
    expect(result.breakdown[0].user_login).toBe("bob");
    expect(result.breakdown[0].input_tokens).toBe(0);
    expect(result.breakdown[0].ai_credits).toBeCloseTo(7.5);
  });

  it("keeps the credits of a developer GitHub reports no activity for", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({
        user_login: "carol",
        code_generation_activity_count: 0,
        code_acceptance_activity_count: 0,
        loc_suggested_to_add_sum: 0,
        loc_added_sum: 0,
        totals_by_language_model: [],
        ai_credits_used: 12.5,
      }),
    ]);

    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].surface).toBe("credit");
    expect(result.breakdown[0].user_login).toBe("carol");
    expect(result.breakdown[0].ai_credits).toBeCloseTo(12.5);
  });

  it("keeps a day total intact when a user record omits its activity counters", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({ user_login: "alice" }),
      createUserReport({
        user_id: 2,
        user_login: "bob",
        code_generation_activity_count: undefined,
        loc_added_sum: undefined,
        totals_by_language_model: [],
      }),
    ]);

    expect(result.total_suggestions_count).toBe(2);
    expect(result.total_lines_accepted).toBe(8);
    expect(result.breakdown.every((row) => Number.isFinite(row.lines_accepted))).toBe(true);
  });

  it("gives a CLI-only developer their own row without taking a colleague's cost", () => {
    const alice = createUserReport({ user_login: "alice" });
    const bob = createUserReport({
      user_id: 2,
      user_login: "bob",
      code_generation_activity_count: 0,
      code_acceptance_activity_count: 0,
      loc_suggested_to_add_sum: 0,
      loc_added_sum: 0,
      totals_by_language_model: [],
      totals_by_cli: {
        session_count: 1,
        request_count: 3,
        prompt_count: 3,
        token_usage: { prompt_tokens_sum: 500, output_tokens_sum: 100 },
      },
    });

    const result = convertUserReportToUsageDay("2026-06-03", [alice, bob]);
    applyBillingToBreakdowns(result.breakdown, [createBillingUsageItem("gpt-4o", 3)], "2026-06-03");

    const bobRow = result.breakdown.find((row) => row.user_login === "bob");
    const aliceRow = result.breakdown.find((row) => row.user_login === "alice");

    expect(bobRow?.surface).toBe("cli");
    expect(bobRow?.cost_usd).toBe(0);
    expect(aliceRow?.cost_usd).toBe(3);
  });

  it("defaults IDE to unknown when totals_by_ide is empty", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({ totals_by_ide: [] }),
    ]);

    expect(result.breakdown[0].editor).toBe("unknown");
  });

  it("returns empty breakdown for empty users array", () => {
    const result = convertUserReportToUsageDay("2026-06-03", []);

    expect(result.total_active_users).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });
});

describe("fetchUsageDays", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function textResponse(body: string): Response {
    return { ok: true, status: 200, statusText: "OK", text: async () => body } as Response;
  }

  function errorResponse(
    status: number,
    statusText: string,
    headers: Record<string, string> = {},
  ): Response {
    return {
      ok: false,
      status,
      statusText,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => "",
    } as unknown as Response;
  }

  function isOrganizationUrl(url: string, org: string): boolean {
    return url === `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}`;
  }

  function requestedUrls(): string[] {
    return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  }

  it("yields the day's usage alongside the billing lines that matched no usage row", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({
      totals_by_language_model: [
        {
          language: "typescript",
          model: "claude-sonnet-4.6",
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
          loc_suggested_to_add_sum: 10,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 8,
          loc_deleted_sum: 0,
        },
      ],
    });
    const billing = {
      timePeriod: { year: 2026, month: 6, day: 3 },
      organization: "acme",
      usageItems: [
        { model: "Claude Sonnet 4.6", grossAmount: 2.5 },
        { model: "Gemini 3 Pro", grossAmount: 4 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        if (url.includes("/settings/billing/")) return textResponse(JSON.stringify(billing));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched).toHaveLength(1);
    expect(fetched[0].days[0].breakdown[0].cost_usd).toBe(2.5);
    expect(fetched[0].unmatchedBilling).toEqual([
      { day: "2026-06-03", model: "Gemini 3 Pro", cost_usd: 4 },
    ]);
    expect(fetched[0].billingUnavailable).toEqual([]);
  });

  it("sends the usage rows of a day whose billing totals nothing", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({
      totals_by_language_model: [
        {
          language: "typescript",
          model: "claude-sonnet-4.6",
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
          loc_suggested_to_add_sum: 10,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 8,
          loc_deleted_sum: 0,
        },
      ],
    });
    const billing = {
      timePeriod: { year: 2026, month: 6, day: 3 },
      organization: "acme",
      usageItems: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        if (url.includes("/settings/billing/")) return textResponse(JSON.stringify(billing));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched[0].billingUnavailable).toEqual([]);
    const chatRows = fetched[0].days[0].breakdown.filter((row) => row.surface === undefined);
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0].cost_usd).toBe(0);
  });

  it("reports the billing lines of a day whose metrics report is missing", async () => {
    const billing = {
      timePeriod: { year: 2026, month: 6, day: 3 },
      organization: "acme",
      usageItems: [{ model: "Claude Sonnet 4.6", grossAmount: 2.5, netAmount: 2.5 }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "acme")) return textResponse(JSON.stringify({ login: "acme" }));
        if (url.includes("/settings/billing/")) return textResponse(JSON.stringify(billing));
        return errorResponse(404, "Not Found");
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched[0].unmatchedBilling).toEqual([
      { day: "2026-06-03", model: "Claude Sonnet 4.6", cost_usd: 2.5 },
    ]);
    expect(fetched[0].days[0].breakdown).toHaveLength(1);
    expect(fetched[0].days[0].breakdown[0].surface).toBe("billing");
    expect(fetched[0].days[0].breakdown[0].cost_usd).toBe(2.5);
    expect(fetched[0].days[0].breakdown[0].user_login).toBe("");
  });

  it("does not treat an exhausted connection failure as a day without usage when the endpoint port contains 404", async () => {
    const billing = {
      timePeriod: { year: 2026, month: 6, day: 3 },
      organization: "acme",
      usageItems: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) return textResponse(JSON.stringify(billing));
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.1:4040" },
        });
      }),
    );

    const days = fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03");

    await expect(days.next()).rejects.toThrow("ECONNREFUSED");
  });

  it("names a day whose billing response carries no usage items", async () => {
    const report = { download_links: [], report_day: "day" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) {
          return textResponse(JSON.stringify({ organization: "acme" }));
        }
        return textResponse(JSON.stringify(report));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched[0].billingUnavailable).toEqual([
      {
        day: "2026-06-03",
        reason: "GitHub returned no usageItems array",
        withheldRecords: 0,
        zeroCostRecords: 0,
        unresolved: true,
      },
    ]);
  });

  it("treats an empty billing body as a day whose billing could not be read", async () => {
    const report = { download_links: [], report_day: "day" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) return textResponse("");
        return textResponse(JSON.stringify(report));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched[0].billingUnavailable).toEqual([
      {
        day: "2026-06-03",
        reason: "GitHub returned no usageItems array",
        withheldRecords: 0,
        zeroCostRecords: 0,
        unresolved: true,
      },
    ]);
  });

  it("imports an organization whose plan does not expose AI credit billing", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({
      totals_by_language_model: [
        {
          language: "typescript",
          model: "claude-sonnet-4.6",
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
          loc_suggested_to_add_sum: 10,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 8,
          loc_deleted_sum: 0,
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) return errorResponse(404, "Not Found");
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    expect(fetched[0].billingUnavailable).toEqual([]);
    expect(fetched[0].days[0].breakdown.some((row) => row.surface === undefined)).toBe(true);
  });

  it("retries a rate-limited billing response and omits the permission hint", async () => {
    process.env.REVENIUM_MAX_RETRIES = "2";
    process.env.REVENIUM_BACKOFF_BASE_MS = "1";
    const report = { download_links: [], report_day: "day" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) {
          return errorResponse(403, "Forbidden", { "retry-after": "0" });
        }
        return textResponse(JSON.stringify(report));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    const [unavailable] = fetched[0].billingUnavailable;
    expect(unavailable.reason).toContain("403");
    expect(unavailable.reason).not.toContain("Administration");
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("billing")),
    ).toHaveLength(2);

    delete process.env.REVENIUM_MAX_RETRIES;
    delete process.env.REVENIUM_BACKOFF_BASE_MS;
  });

  it("withholds the cost-bearing rows of the day whose billing data could not be fetched", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({
      code_generation_activity_count: 5,
      code_acceptance_activity_count: 2,
      loc_suggested_to_add_sum: 30,
      loc_added_sum: 20,
      totals_by_language_model: [
        {
          language: "typescript",
          model: "claude-sonnet-4.6",
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
          loc_suggested_to_add_sum: 10,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 8,
          loc_deleted_sum: 0,
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) return errorResponse(403, "Forbidden");
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    const [unavailable] = fetched[0].billingUnavailable;
    expect(unavailable.day).toBe("2026-06-03");
    expect(unavailable.reason).toContain("403");
    expect(unavailable.reason).toContain("Administration");
    expect(unavailable.withheldRecords).toBe(1);
    expect(unavailable.zeroCostRecords).toBe(0);
    expect(fetched[0].days[0].breakdown.every((row) => row.surface !== undefined)).toBe(true);
    expect(fetched[0].days[0].breakdown.map((row) => row.surface)).toContain("completion");
  });

  it("counts the rows kept at zero cost when the caller allows missing billing", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({
      code_generation_activity_count: 5,
      code_acceptance_activity_count: 2,
      loc_suggested_to_add_sum: 30,
      loc_added_sum: 20,
      totals_by_language_model: [
        {
          language: "typescript",
          model: "claude-sonnet-4.6",
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
          loc_suggested_to_add_sum: 10,
          loc_suggested_to_delete_sum: 0,
          loc_added_sum: 8,
          loc_deleted_sum: 0,
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) return errorResponse(403, "Forbidden");
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-03", {
      allowMissingBilling: true,
    })) {
      fetched.push(batch);
    }

    const [unavailable] = fetched[0].billingUnavailable;
    expect(unavailable.withheldRecords).toBe(0);
    expect(unavailable.zeroCostRecords).toBe(1);

    const costBearing = fetched[0].days[0].breakdown.filter((row) => row.surface === undefined);
    expect(costBearing).toHaveLength(1);
    expect(costBearing[0].cost_usd).toBe(0);
  });

  it("reads billing from the documented AI credit usage endpoint", async () => {
    const report = { download_links: [], report_day: "day" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) {
          return textResponse(JSON.stringify({ usageItems: [] }));
        }
        return textResponse(JSON.stringify(report));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme org", "2026-06-03", "2026-06-03")) {
      fetched.push(batch);
    }

    const billingUrls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.includes("/settings/billing/"));

    expect(billingUrls).toEqual([
      `${GITHUB_API_BASE_URL}/orgs/acme%20org/settings/billing/ai_credit/usage?year=2026&month=6&day=3`,
    ]);
  });

  it("throws naming the organization when GitHub answers 404 for the organization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "revenium-no-such-org")) return errorResponse(404, "Not Found");
        return textResponse(JSON.stringify({ download_links: [], report_day: "day" }));
      }),
    );

    const days = fetchUsageDays("token", "revenium-no-such-org", "2026-06-03", "2026-06-30");

    await expect(days.next()).rejects.toThrow(
      'GitHub organization "revenium-no-such-org" could not be reached with this token.',
    );
    expect(requestedUrls().some((url) => url.includes("/copilot/metrics/reports/"))).toBe(false);
  });

  it("propagates a rejected token from the organization pre-check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "acme")) return errorResponse(401, "Bad credentials");
        return textResponse(JSON.stringify({ download_links: [], report_day: "day" }));
      }),
    );

    const days = fetchUsageDays("token", "acme", "2026-06-03", "2026-06-30");

    await expect(days.next()).rejects.toThrow("401");
    expect(requestedUrls().some((url) => url.includes("/copilot/metrics/reports/"))).toBe(false);
  });

  it("issues a single organization request regardless of the range length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/settings/billing/")) {
          return textResponse(JSON.stringify({ usageItems: [] }));
        }
        return textResponse(JSON.stringify({ download_links: [], report_day: "day" }));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-01", "2026-06-10")) {
      fetched.push(batch);
    }

    expect(fetched).toHaveLength(10);
    expect(requestedUrls().filter((url) => isOrganizationUrl(url, "acme"))).toHaveLength(1);
  });

  it("yields the days that have a report when only some days answer 404", async () => {
    const report = { download_links: ["https://example.test/report.ndjson"], report_day: "day" };
    const userReport = createUserReport({ day: "2026-06-04" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "acme")) return textResponse(JSON.stringify({ login: "acme" }));
        if (url.includes("/settings/billing/")) {
          return textResponse(JSON.stringify({ usageItems: [] }));
        }
        if (url.includes("day=2026-06-03")) return errorResponse(404, "Not Found");
        if (url.includes("/copilot/metrics/reports/")) return textResponse(JSON.stringify(report));
        return textResponse(JSON.stringify(userReport));
      }),
    );

    const fetched: CopilotUsageFetch[] = [];
    for await (const batch of fetchUsageDays("token", "acme", "2026-06-03", "2026-06-04")) {
      fetched.push(batch);
    }

    expect(fetched.filter((batch) => batch.days.length > 0)).toHaveLength(1);
    expect(fetched[1].days[0].day).toBe("2026-06-04");
  });
});

describe("checkCopilotAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function failingResponse(status: number, statusText: string, body = "") {
    return {
      ok: false,
      status,
      statusText,
      headers: { get: () => null },
      text: async () => body,
    };
  }

  function okResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    };
  }

  function isOrganizationUrl(url: string, org: string): boolean {
    return url === `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}`;
  }

  it("reports the organization as unreachable when GitHub answers 404 for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failingResponse(404, "Not Found")),
    );

    await expect(checkCopilotAccess("token", "revenium-no-such-org")).resolves.toEqual({
      status: "organization-unreachable",
    });
  });

  it("reports the metrics as unreadable when the token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failingResponse(401, "Unauthorized", "Bad credentials")),
    );

    await expect(checkCopilotAccess("token", "acme")).resolves.toEqual({
      status: "metrics-unreadable",
    });
  });

  it("surfaces the error instead of blaming the organization when the probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failingResponse(500, "Internal Server Error")),
    );

    const access = await checkCopilotAccess("token", "acme");

    expect(access.status).toBe("failed");
    expect(access).toHaveProperty("message", expect.stringContaining("500"));
  });

  it("reports the metrics as unreadable when the organization is reachable but metrics are denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "acme")) return okResponse({ login: "acme" });
        return failingResponse(
          403,
          "Forbidden",
          "Resource not accessible by personal access token",
        );
      }),
    );

    await expect(checkCopilotAccess("token", "acme")).resolves.toEqual({
      status: "metrics-unreadable",
    });
  });

  it("reports connected when the probed day has no report yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isOrganizationUrl(url, "acme")) return okResponse({ login: "acme" });
        return failingResponse(404, "Not Found");
      }),
    );

    await expect(checkCopilotAccess("token", "acme")).resolves.toEqual({ status: "connected" });
  });

  it("reports connected once both the organization and the metrics answer", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isOrganizationUrl(url, "acme")) return okResponse({ login: "acme" });
      return okResponse({ download_links: [], report_day: "day" });
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(checkCopilotAccess("token", "acme")).resolves.toEqual({ status: "connected" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))[0]).toBe(
      `${GITHUB_API_BASE_URL}/orgs/acme`,
    );
  });
});

describe("githubRequest transport retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a reset connection and succeeds on the second attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      )
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ download_links: [], report_day: "day" }),
      } as Response);

    vi.stubGlobal("fetch", fetchMock);

    await expect(checkCopilotAccess("token", "acme")).resolves.toEqual({ status: "connected" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
