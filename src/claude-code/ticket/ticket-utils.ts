const DEFAULT_TICKET_PATTERN_SOURCE = String.raw`[A-Za-z][A-Za-z0-9_]{0,63}-\d{1,10}`;
export const DEFAULT_TICKET_REGEX = new RegExp(`^${DEFAULT_TICKET_PATTERN_SOURCE}$`);

export const MAX_TICKET_ID_LENGTH = 128;

export const TICKET_NONE = "none";

export function isValidTicketId(id: string, regexOverride?: RegExp): boolean {
  if (id.length > MAX_TICKET_ID_LENGTH) return false;
  if (id === TICKET_NONE) return true;
  const pattern = regexOverride ?? getTicketRegex();
  return pattern.test(id);
}

export function getTicketRegex(): RegExp {
  const fromEnv = process.env.REVENIUM_TICKET_REGEX;
  if (fromEnv) {
    const unanchored = fromEnv.replace(/^\^/, "").replace(/\$$/, "");
    try {
      return new RegExp(`^(?:${unanchored})$`);
    } catch {}
  }
  return DEFAULT_TICKET_REGEX;
}

export function inferTicketFromBranch(branch: string | undefined | null): string | undefined {
  if (!branch) return undefined;

  const match = branch.match(new RegExp(`(${DEFAULT_TICKET_PATTERN_SOURCE})`));
  if (!match) return undefined;

  const candidate = match[1].toUpperCase();
  if (getTicketRegex().test(candidate)) {
    return candidate;
  }
  return undefined;
}

export function buildTraceName(ticketId: string, title?: string): string {
  const id = ticketId.toUpperCase();
  if (title && title.trim()) {
    return `${id}: ${title.trim()}`;
  }
  return id;
}

export function buildJobId(ticketId: string): string {
  return `interactive-coding-${ticketId.toUpperCase()}`;
}

export function encodeOtelAttrValue(value: string): string {
  return value
    .replace(/[\r\n]/g, "")
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/\\/g, "%5C")
    .replace(/\$/g, "%24")
    .replace(/`/g, "%60")
    .replace(/,/g, "%2C")
    .replace(/=/g, "%3D")
    .replace(/"/g, "%22");
}

export function buildTicketOtelAttrs(ticketId: string, title?: string): string {
  const traceName = buildTraceName(ticketId, title);
  const jobId = buildJobId(ticketId);

  const pairs: [string, string][] = [
    ["revenium.trace.name", encodeOtelAttrValue(traceName)],
    ["revenium.trace.type", "interactive-coding"],
    ["revenium.task.type", "interactive-coding"],
    ["revenium.job.id", encodeOtelAttrValue(jobId)],
    ["revenium.job.name", encodeOtelAttrValue(traceName)],
    ["revenium.job.type", "interactive-coding"],
  ];

  return pairs.map(([k, v]) => `${k}=${v}`).join(",");
}

export function mergeOtelAttrs(existing: string | undefined, ticketAttrs: string): string {
  if (!existing) return ticketAttrs;
  return `${existing},${ticketAttrs}`;
}
