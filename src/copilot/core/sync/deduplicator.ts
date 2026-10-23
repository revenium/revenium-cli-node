import { createHash } from "node:crypto";
import type { CopilotUsageDay, CopilotUsageBreakdown } from "../../types.js";

export function computeBreakdownHash(
  day: CopilotUsageDay,
  breakdown: CopilotUsageBreakdown,
): string {
  const raw = JSON.stringify({
    d: day.day,
    l: breakdown.language,
    e: breakdown.editor,
    m: breakdown.model,
    u: breakdown.user_login,
    s: breakdown.surface,
  });

  return createHash("sha256").update(raw).digest("hex");
}
