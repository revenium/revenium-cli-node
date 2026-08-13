export interface AssociationRequest {
  sessionId: string;
  ticketId: string;
  ticketTitle?: string;
  reason?: string;
  source?: string;
  subscriberEmail?: string;
  repo?: string;
  branch?: string;

  teamId?: string;
}

export type AssociationResult =
  | { ok: true; degraded: false }
  | { ok: false; degraded: true; retryable: boolean; reason: string };

const REQUEST_TIMEOUT_MS = 3_000;
const LONG_TEXT_LIMIT = 500;
const CONTEXT_TEXT_LIMIT = 255;

function capped(value: string | undefined, limit: number): string | undefined {
  return value?.slice(0, limit);
}

export function sanitizeRepoUrl(remote: string): string {
  const schemeStripped = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
  if (schemeStripped !== remote) return schemeStripped;
  return remote.replace(/^[^/]+@/, "");
}

export async function postAssociation(
  baseEndpoint: string,
  apiKey: string,
  req: AssociationRequest,
): Promise<AssociationResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const url = new URL(
      `${baseEndpoint.replace(/\/+$/, "")}/v2/api/sessions/${encodeURIComponent(req.sessionId)}/attribution`,
    );
    if (req.teamId) {
      url.searchParams.set("teamId", req.teamId);
    }

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const body: Record<string, string> = {
      ticketId: req.ticketId,
      source: req.source ?? "claude-code",
    };
    if (req.ticketTitle) body.ticketTitle = capped(req.ticketTitle, LONG_TEXT_LIMIT)!;
    if (req.reason) body.reason = capped(req.reason, LONG_TEXT_LIMIT)!;
    if (req.subscriberEmail) body.subscriberEmail = req.subscriberEmail;
    if (req.repo) body.repo = capped(sanitizeRepoUrl(req.repo), CONTEXT_TEXT_LIMIT)!;
    if (req.branch) body.branch = capped(req.branch, CONTEXT_TEXT_LIMIT)!;
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, degraded: false };
    }

    return {
      ok: false,
      degraded: true,
      retryable:
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500,
      reason: `Session attribution API returned ${response.status}`,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);

    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `Attribution API timed out after ${REQUEST_TIMEOUT_MS}ms; using launch-time OTEL attrs`
        : `Attribution API unavailable: ${err instanceof Error ? err.message : "unknown error"}`;

    return { ok: false, degraded: true, retryable: true, reason };
  }
}
