import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

let testHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testHome,
  };
});

import {
  setActiveTicket,
  setRepoTicket,
  getRepoTicket,
  getActiveTicket,
  listSessionStatesForCwd,
  pruneStaleState,
  markAssociationPending,
  clearAssociationPending,
  isAssociationPending,
} from "../../../src/claude-code/ticket/session-state.js";

function stateDir(): string {
  return join(testHome, ".revenium", "ticket-state");
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "revenium-state-test-"));
});

afterEach(() => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

describe("setRepoTicket / getRepoTicket", () => {
  it("persists repo state as a plain ticket hint (launch path)", async () => {
    await setRepoTicket("/some/repo", "PRODUCT-1234", "My title");
    const state = await getRepoTicket("/some/repo");
    expect(state).not.toBeNull();
    expect(state?.ticketId).toBe("PRODUCT-1234");
    expect(state?.ticketTitle).toBe("My title");

    expect(state).not.toHaveProperty("lastSessionId");
  });

  it("returns null for an unknown cwd", async () => {
    expect(await getRepoTicket("/never/seen")).toBeNull();
  });

  it("keeps long cwd paths with a shared prefix in separate state files", async () => {
    const sharedPrefix = `/repo/${"x".repeat(120)}`;
    const firstCwd = `${sharedPrefix}/first-suffix`;
    const secondCwd = `${sharedPrefix}/second-suffix`;

    await setRepoTicket(firstCwd, "BACK-1");
    await setRepoTicket(secondCwd, "BACK-2");

    expect((await getRepoTicket(firstCwd))?.ticketId).toBe("BACK-1");
    expect((await getRepoTicket(secondCwd))?.ticketId).toBe("BACK-2");
  });
});

describe("setActiveTicket", () => {
  it("writes session state (with cwd + postedTicketId) and a repo-state hint", async () => {
    await setActiveTicket("sess-1", "/some/repo", "BACK-42", "Title", "BACK-42");
    const session = await getActiveTicket("sess-1", "/some/repo");
    expect(session?.ticketId).toBe("BACK-42");
    expect(session?.postedTicketId).toBe("BACK-42");
    const repo = await getRepoTicket("/some/repo");
    expect(repo?.ticketId).toBe("BACK-42");
    expect(repo).not.toHaveProperty("lastSessionId");
  });

  it("keeps pending delivery state separate from authoritative session and repo state", async () => {
    await setActiveTicket("sess-1", "/some/repo", "BACK-42", "Title", "BACK-42", "reason");
    await markAssociationPending("sess-1", "BACK-42");
    expect(await isAssociationPending("sess-1", "BACK-42")).toBe(true);

    await clearAssociationPending("sess-1", "BACK-42");
    expect(await isAssociationPending("sess-1", "BACK-42")).toBe(false);
    expect((await getActiveTicket("sess-1", "/some/repo"))?.ticketId).toBe("BACK-42");
    expect((await getRepoTicket("/some/repo"))?.reason).toBe("reason");
  });

  it("getActiveTicket falls back to repo state for an unknown session id", async () => {
    await setActiveTicket("sess-1", "/some/repo", "BACK-42");
    const resumed = await getActiveTicket("sess-2", "/some/repo");
    expect(resumed?.ticketId).toBe("BACK-42");
    expect(resumed?.sessionId).toBe("sess-2");
  });
});

describe("listSessionStatesForCwd", () => {
  it("returns only live session-state files matching the cwd", async () => {
    await setActiveTicket("sess-a", "/repo/x", "BACK-1");
    await setActiveTicket("sess-b", "/repo/y", "BACK-2");

    const forX = await listSessionStatesForCwd("/repo/x");
    expect(forX).toHaveLength(1);
    expect(forX[0]?.sessionId).toBe("sess-a");

    const forNowhere = await listSessionStatesForCwd("/repo/never-seen");
    expect(forNowhere).toHaveLength(0);
  });

  it("returns multiple entries when ≥2 concurrent sessions share a cwd (ambiguous)", async () => {
    await setActiveTicket("sess-a", "/repo/shared", "BACK-1");
    await setActiveTicket("sess-b", "/repo/shared", "BACK-2");

    const found = await listSessionStatesForCwd("/repo/shared");
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
  });

  it("excludes session-state files older than maxAgeMs (no longer live)", async () => {
    await setActiveTicket("sess-old", "/repo/stale", "BACK-1");

    const dir = stateDir();
    const files = await readdir(dir);
    const sessionFile = files.find((f) => f.includes("sess-old"));
    expect(sessionFile).toBeDefined();
    const full = join(dir, sessionFile as string);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(full, old, old);

    const found = await listSessionStatesForCwd("/repo/stale", 30 * 60 * 1000);
    expect(found).toHaveLength(0);
  });

  it("returns an empty array when the state dir does not exist", async () => {
    expect(await listSessionStatesForCwd("/anything")).toEqual([]);
  });
});

describe("pruneStaleState", () => {
  it("deletes state files older than the cutoff and keeps fresh ones", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const oldFile = join(stateDir(), "session-old.json");
    const freshFile = join(stateDir(), "session-fresh.json");
    const oldCount = join(stateDir(), "session-old-count.txt");
    writeFileSync(oldFile, "{}");
    writeFileSync(freshFile, "{}");
    writeFileSync(oldCount, "3");

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, old, old);
    utimesSync(oldCount, old, old);

    const pruned = await pruneStaleState(30);
    expect(pruned).toBe(2);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(oldCount)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("returns 0 and never throws when the state dir does not exist", async () => {
    await expect(pruneStaleState(30)).resolves.toBe(0);
  });

  it("ignores non-state files", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const other = join(stateDir(), "README.md");
    writeFileSync(other, "x");
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(other, old, old);
    await pruneStaleState(30);
    expect(existsSync(other)).toBe(true);
  });
});
