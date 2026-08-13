import { describe, it, expect, vi } from "vitest";
import {
  isValidTicketId,
  MAX_TICKET_ID_LENGTH,
  inferTicketFromBranch,
  buildTraceName,
  buildJobId,
  encodeOtelAttrValue,
  buildTicketOtelAttrs,
  mergeOtelAttrs,
  TICKET_NONE,
} from "../../../src/claude-code/ticket/ticket-utils.js";

describe("isValidTicketId", () => {
  it("accepts standard PROJECT-123 format", () => {
    expect(isValidTicketId("PRODUCT-1234")).toBe(true);
    expect(isValidTicketId("BACK-42")).toBe(true);
    expect(isValidTicketId("A-1")).toBe(true);
  });

  it("accepts mixed case", () => {
    expect(isValidTicketId("product-1234")).toBe(true);
    expect(isValidTicketId("Product-99")).toBe(true);
  });

  it("accepts the explicit none opt-out", () => {
    expect(isValidTicketId(TICKET_NONE)).toBe(true);
  });

  it("rejects IDs that start with a digit", () => {
    expect(isValidTicketId("1PRODUCT-123")).toBe(false);
  });

  it("rejects IDs with no digit suffix", () => {
    expect(isValidTicketId("PRODUCT")).toBe(false);
    expect(isValidTicketId("PRODUCT-")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTicketId("")).toBe(false);
  });

  it("rejects bare numbers", () => {
    expect(isValidTicketId("123")).toBe(false);
  });

  it("rejects a valid pattern with trailing garbage (full-match only)", () => {
    expect(isValidTicketId("PRODUCT-1234x")).toBe(false);
    expect(isValidTicketId("PRODUCT-1234 ")).toBe(false);
  });

  it("anchors a configured REVENIUM_TICKET_REGEX so substrings are rejected", () => {
    const original = process.env.REVENIUM_TICKET_REGEX;
    process.env.REVENIUM_TICKET_REGEX = "(PRODUCT|BACK)-[0-9]+";
    try {
      expect(isValidTicketId("PRODUCT-12")).toBe(true);
      expect(isValidTicketId("PRODUCT-12x")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.REVENIUM_TICKET_REGEX;
      else process.env.REVENIUM_TICKET_REGEX = original;
    }
  });

  it("accepts long project key (up to 64 alpha chars)", () => {
    expect(isValidTicketId("A".repeat(64) + "-1")).toBe(true);
    expect(isValidTicketId("A".repeat(65) + "-1")).toBe(false);
  });

  it("rejects overlong IDs before applying an organization regex", () => {
    const regex = /^(a+)+$/;
    const testSpy = vi.spyOn(regex, "test");

    expect(isValidTicketId("a".repeat(MAX_TICKET_ID_LENGTH + 1), regex)).toBe(false);
    expect(testSpy).not.toHaveBeenCalled();
  });
});

describe("inferTicketFromBranch", () => {
  it("infers ticket from bare branch product-1632-foo", () => {
    expect(inferTicketFromBranch("product-1632-foo")).toBe("PRODUCT-1632");
  });

  it("infers ticket from feature/ prefixed branch", () => {
    expect(inferTicketFromBranch("feature/PRODUCT-1632-foo")).toBe("PRODUCT-1632");
  });

  it("infers ticket from bugfix/ prefixed branch", () => {
    expect(inferTicketFromBranch("bugfix/back-42-fix-thing")).toBe("BACK-42");
  });

  it("infers ticket from branch with uppercase prefix", () => {
    expect(inferTicketFromBranch("BACK-42-something")).toBe("BACK-42");
  });

  it("returns undefined for main", () => {
    expect(inferTicketFromBranch("main")).toBeUndefined();
  });

  it("returns undefined for develop", () => {
    expect(inferTicketFromBranch("develop")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(inferTicketFromBranch(undefined)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(inferTicketFromBranch(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(inferTicketFromBranch("")).toBeUndefined();
  });

  it("returns undefined for no-ticket-description", () => {
    expect(inferTicketFromBranch("no-ticket-description")).toBeUndefined();
  });

  it("returns the first match when multiple ticket-like segments appear", () => {
    const result = inferTicketFromBranch("BACK-1-then-PRODUCT-2");
    expect(result).toBe("BACK-1");
  });

  it("uppercases a lowercase ticket from branch", () => {
    expect(inferTicketFromBranch("product-1234-update-docs")).toBe("PRODUCT-1234");
  });
});

describe("buildTraceName (D4)", () => {
  it("formats as TICKET: title when title is present", () => {
    expect(buildTraceName("PRODUCT-1234", "Fix the thing")).toBe("PRODUCT-1234: Fix the thing");
  });

  it("uses ID only when no title", () => {
    expect(buildTraceName("PRODUCT-1234")).toBe("PRODUCT-1234");
  });

  it("uppercases ticket ID", () => {
    expect(buildTraceName("product-1234", "My title")).toBe("PRODUCT-1234: My title");
  });

  it("trims whitespace from title", () => {
    expect(buildTraceName("BACK-42", "  Padded title  ")).toBe("BACK-42: Padded title");
  });

  it("uses ID only when title is empty string", () => {
    expect(buildTraceName("BACK-42", "")).toBe("BACK-42");
  });

  it("uses ID only when title is whitespace only", () => {
    expect(buildTraceName("BACK-42", "   ")).toBe("BACK-42");
  });
});

describe("buildJobId (D5)", () => {
  it("produces interactive-coding-TICKET format", () => {
    expect(buildJobId("PRODUCT-1234")).toBe("interactive-coding-PRODUCT-1234");
  });

  it("uppercases ticket ID", () => {
    expect(buildJobId("product-1234")).toBe("interactive-coding-PRODUCT-1234");
  });

  it("does NOT include an epoch suffix", () => {
    const id = buildJobId("PRODUCT-9999");

    expect(id).not.toMatch(/-\d{10,}$/);
    expect(id).toBe("interactive-coding-PRODUCT-9999");
  });
});

describe("encodeOtelAttrValue", () => {
  it("encodes spaces as %20", () => {
    expect(encodeOtelAttrValue("hello world")).toContain("%20");
    expect(encodeOtelAttrValue("hello world")).not.toContain(" ");
  });

  it("encodes commas as %2C", () => {
    expect(encodeOtelAttrValue("a,b")).toBe("a%2Cb");
  });

  it("encodes equals signs as %3D", () => {
    expect(encodeOtelAttrValue("a=b")).toBe("a%3Db");
  });

  it("encodes dollar signs as %24", () => {
    expect(encodeOtelAttrValue("$HOME")).toBe("%24HOME");
  });

  it("encodes backticks as %60", () => {
    expect(encodeOtelAttrValue("`cmd`")).toBe("%60cmd%60");
  });

  it("encodes double quotes as %22", () => {
    expect(encodeOtelAttrValue('"quoted"')).toBe("%22quoted%22");
  });

  it("encodes existing percent signs as %25 (to avoid double-decode)", () => {
    expect(encodeOtelAttrValue("50%")).toBe("50%25");
  });

  it("encodes backslash as %5C", () => {
    expect(encodeOtelAttrValue("path\\file")).toBe("path%5Cfile");
  });
});

describe("buildTicketOtelAttrs", () => {
  it("includes all required keys", () => {
    const attrs = buildTicketOtelAttrs("PRODUCT-1234", "My title");
    expect(attrs).toContain("revenium.trace.name=");
    expect(attrs).toContain("revenium.trace.type=interactive-coding");
    expect(attrs).toContain("revenium.task.type=interactive-coding");
    expect(attrs).toContain("revenium.job.id=");
    expect(attrs).toContain("revenium.job.name=");
    expect(attrs).toContain("revenium.job.type=interactive-coding");
  });

  it("D4: trace name encodes spaces from 'TICKET: title' format (colon is safe in baggage values)", () => {
    const attrs = buildTicketOtelAttrs("PRODUCT-1234", "My title");

    expect(attrs).toContain("revenium.trace.name=PRODUCT-1234:%20My%20title");
    expect(attrs).not.toContain("revenium.trace.name=PRODUCT-1234: My title");
  });

  it("D5: job.id is interactive-coding-TICKET with no epoch suffix", () => {
    const attrs = buildTicketOtelAttrs("PRODUCT-1234");
    expect(attrs).toContain("revenium.job.id=interactive-coding-PRODUCT-1234");

    expect(attrs).not.toMatch(/job\.id=interactive-coding-PRODUCT-1234-\d+/);
  });

  it("handles ticket with no title", () => {
    const attrs = buildTicketOtelAttrs("BACK-42");
    expect(attrs).toContain("revenium.trace.name=BACK-42");
  });
});

describe("mergeOtelAttrs", () => {
  it("appends to existing attrs", () => {
    const merged = mergeOtelAttrs("existing=value", "new=attr");
    expect(merged).toBe("existing=value,new=attr");
  });

  it("returns ticket attrs when no existing attrs", () => {
    expect(mergeOtelAttrs(undefined, "ticket=attr")).toBe("ticket=attr");
  });

  it("returns ticket attrs when existing is empty string", () => {
    expect(mergeOtelAttrs("", "ticket=attr")).toBe("ticket=attr");
  });
});
