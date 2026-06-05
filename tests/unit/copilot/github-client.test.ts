import { describe, it, expect } from "vitest";
import { convertUserReportToUsageDay } from "../../../src/copilot/core/github-client.js";
import type { CopilotUserDayReport } from "../../../src/copilot/types.js";

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

  it("handles users with no language_model breakdowns", () => {
    const result = convertUserReportToUsageDay("2026-06-03", [
      createUserReport({ totals_by_language_model: [] }),
    ]);

    expect(result.total_active_users).toBe(1);
    expect(result.breakdown).toHaveLength(0);
    expect(result.total_suggestions_count).toBe(0);
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
