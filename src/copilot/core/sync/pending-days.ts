import type { CopilotUsageBreakdown, CopilotUsageDay } from "../../types.js";

export function appendBreakdown(
  pendingDays: CopilotUsageDay[],
  day: CopilotUsageDay,
  breakdown: CopilotUsageBreakdown,
): void {
  const lastDay = pendingDays[pendingDays.length - 1];

  if (lastDay?.day === day.day) {
    lastDay.breakdown.push(breakdown);
    return;
  }

  pendingDays.push({ ...day, breakdown: [breakdown] });
}
