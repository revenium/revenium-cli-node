import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const mockState = vi.hoisted(() => ({
  home: "",
  spawnSync: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockState.home || "/nonexistent-home",
  };
});

const spawnSyncMock = vi.fn(
  (): {
    status: number | null;
    error: Error | undefined;
    signal?: NodeJS.Signals;
  } => ({ status: 0, error: undefined }),
);
mockState.spawnSync = spawnSyncMock;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockState.spawnSync?.(...(args as [])),
  };
});

let testHome = "";

import {
  ticketLaunchCommand,
  ticketSwitchCommand,
  ticketGateAssociateCommand,
} from "../../../src/claude-code/commands/ticket.js";
import {
  getRepoTicket,
  setActiveTicket,
  listSessionStatesForCwd,
  markAssociationPending,
  isAssociationPending,
} from "../../../src/claude-code/ticket/session-state.js";

const EXIT_SENTINEL = new Error("process.exit called");

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "revenium-cmd-test-"));
  mockState.home = testHome;
  spawnSyncMock.mockClear();
  spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw EXIT_SENTINEL;
  });

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

function writeFakeConfig(): void {
  const dir = join(testHome, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "revenium.env"),
    [
      "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
      'export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.revenium.test/meter/v2/otlp"',
      'export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=hak_testkey123"',
      'export REVENIUM_SUBSCRIBER_EMAIL="dev@example.com"',
      'export REVENIUM_TEAM_ID="teamHash123"',
      "",
    ].join("\n"),
  );
}

function mockFetchOk(status = 201) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve("{}"),
  });
}

describe("ticket launch", () => {
  it("persists repo-level state before exec'ing claude", async () => {
    await expect(
      ticketLaunchCommand({ ticketId: "PRODUCT-1234", title: "My title", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);

    const repo = await getRepoTicket("/launch/repo");
    expect(repo?.ticketId).toBe("PRODUCT-1234");
    expect(repo?.ticketTitle).toBe("My title");

    expect(repo).not.toHaveProperty("lastSessionId");
  });

  it("does NOT POST any attribution (no real session id exists pre-launch)", async () => {
    writeFakeConfig();
    await expect(
      ticketLaunchCommand({ ticketId: "PRODUCT-1234", title: "T", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("passes REVENIUM_TICKET and merged OTEL attrs to the claude process env", async () => {
    await expect(
      ticketLaunchCommand({ ticketId: "product-9", title: "T", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const callArgs = spawnSyncMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(callArgs[0]).toBe("claude");
    const env = callArgs[2].env;
    expect(env.REVENIUM_TICKET).toBe("PRODUCT-9");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("revenium.job.id=interactive-coding-PRODUCT-9");
  });

  it("rejects an invalid ticket id without spawning claude", async () => {
    await expect(
      ticketLaunchCommand({ ticketId: "not_a_ticket", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects `ticket launch none` because an opt-out reason is required", async () => {
    await expect(ticketLaunchCommand({ ticketId: "none", cwd: "/launch/repo" })).rejects.toThrow(
      EXIT_SENTINEL.message,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("exits nonzero when claude is terminated by a signal", async () => {
    spawnSyncMock.mockReturnValue({ status: null, error: undefined, signal: "SIGTERM" });

    await expect(
      ticketLaunchCommand({ ticketId: "PRODUCT-1234", title: "T", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("preserves claude's numeric exit status", async () => {
    spawnSyncMock.mockReturnValue({ status: 7, error: undefined });

    await expect(
      ticketLaunchCommand({ ticketId: "PRODUCT-1234", title: "T", cwd: "/launch/repo" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);

    expect(process.exit).toHaveBeenCalledWith(7);
  });
});

describe("ticket switch", () => {
  it("resolves the session id from the sole live session-state file for the cwd and POSTs with it", async () => {
    writeFakeConfig();
    mockFetchOk();

    await setActiveTicket("real-sess-1", "/switch/repo", "PRODUCT-1", "Old");

    await ticketSwitchCommand({ ticketId: "BACK-2", ticketTitle: "New work", cwd: "/switch/repo" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.revenium.test/v2/api/sessions/real-sess-1/attribution?teamId=teamHash123",
    );
    const body = JSON.parse(opts.body as string);
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("effectiveFrom");
    expect(body.ticketId).toBe("BACK-2");
    const state = await listSessionStatesForCwd("/switch/repo");
    expect(state.find((entry) => entry.sessionId === "real-sess-1")?.postedTicketId).toBe("BACK-2");
  });

  it("prefers an explicit --session-id over the live-session lookup", async () => {
    writeFakeConfig();
    mockFetchOk();
    await setActiveTicket("repo-sess", "/switch/repo", "PRODUCT-1");

    await ticketSwitchCommand({
      ticketId: "BACK-3",
      ticketTitle: "T",
      cwd: "/switch/repo",
      sessionId: "explicit-sess",
    });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/v2/api/sessions/explicit-sess/attribution");
  });

  it("with no resolvable session id: persists repo state only and does NOT POST", async () => {
    writeFakeConfig();
    await ticketSwitchCommand({ ticketId: "BACK-4", ticketTitle: "T", cwd: "/fresh/repo" });

    expect(global.fetch).not.toHaveBeenCalled();
    const repo = await getRepoTicket("/fresh/repo");
    expect(repo?.ticketId).toBe("BACK-4");
    expect(repo).not.toHaveProperty("lastSessionId");
  });

  it("refuses to guess when ≥2 concurrent sessions share the cwd (worst case: no-op, not mis-attribution)", async () => {
    writeFakeConfig();
    mockFetchOk();

    await setActiveTicket("sess-a", "/switch/ambiguous", "PRODUCT-1");
    await setActiveTicket("sess-b", "/switch/ambiguous", "BACK-9");

    const logSpy = vi.spyOn(console, "log");
    await ticketSwitchCommand({ ticketId: "BACK-5", ticketTitle: "T", cwd: "/switch/ambiguous" });

    expect(global.fetch).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/multiple active claude code sessions/i);
    expect(logged).toContain("switch-ticket BACK-5");

    const [stillA, stillB] = await Promise.all([
      listSessionStatesForCwd("/switch/ambiguous").then((s) =>
        s.find((x) => x.sessionId === "sess-a"),
      ),
      listSessionStatesForCwd("/switch/ambiguous").then((s) =>
        s.find((x) => x.sessionId === "sess-b"),
      ),
    ]);
    expect(stillA?.ticketId).toBe("PRODUCT-1");
    expect(stillB?.ticketId).toBe("BACK-9");

    const repo = await getRepoTicket("/switch/ambiguous");
    expect(repo?.ticketId).toBe("BACK-5");
  });

  it("never fabricates a session id (no unknown-<epoch> in POST bodies)", async () => {
    writeFakeConfig();
    mockFetchOk();
    await setActiveTicket("real-sess-9", "/switch/repo9", "PRODUCT-1");
    await ticketSwitchCommand({ ticketId: "BACK-5", ticketTitle: "T", cwd: "/switch/repo9" });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).not.toMatch(/\/sessions\/unknown-/);
    expect(url).not.toMatch(/\/sessions\/launch-/);
  });

  it("degraded POST (404) — shows degraded notice and still persists state", async () => {
    writeFakeConfig();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    await setActiveTicket("sess-degraded", "/switch/degraded", "PRODUCT-1");

    const logSpy = vi.spyOn(console, "log");
    await ticketSwitchCommand({
      ticketId: "BACK-6",
      ticketTitle: "Degraded",
      cwd: "/switch/degraded",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/session attribution api returned 404/i);

    const repo = await getRepoTicket("/switch/degraded");
    expect(repo?.ticketId).toBe("BACK-6");
    expect(await isAssociationPending("sess-degraded", "BACK-6")).toBe(false);
  });

  it("rejects an explicit opt-out without a reason", async () => {
    await expect(
      ticketSwitchCommand({ ticketId: "none", sessionId: "sess-none", cwd: "/switch/none" }),
    ).rejects.toThrow(EXIT_SENTINEL.message);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("degraded POST (non-2xx/non-404) — shows degraded notice and still persists state", async () => {
    writeFakeConfig();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    await setActiveTicket("sess-503", "/switch/503repo", "PRODUCT-1");

    const logSpy = vi.spyOn(console, "log");
    await ticketSwitchCommand({
      ticketId: "BACK-7",
      ticketTitle: "Unavailable",
      cwd: "/switch/503repo",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/attribution api returned 503/i);
    const repo = await getRepoTicket("/switch/503repo");
    expect(repo?.ticketId).toBe("BACK-7");
    const state = await listSessionStatesForCwd("/switch/503repo");
    expect(state.find((entry) => entry.sessionId === "sess-503")?.postedTicketId).toBe("BACK-7");
    expect(await isAssociationPending("sess-503", "BACK-7")).toBe(true);
  });
});

describe("ticket-gate associate (background worker)", () => {
  it("fails open before resolving or POSTing an invalid ticket id", async () => {
    writeFakeConfig();

    await expect(
      ticketGateAssociateCommand({ sessionId: "hook-sess-invalid", ticketId: "not_a_ticket" }),
    ).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POSTs the attribution with the supplied real session id", async () => {
    writeFakeConfig();
    mockFetchOk();
    await setActiveTicket("hook-sess-1", "/some/repo", "PRODUCT-7", "From hook", "PRODUCT-7");
    await markAssociationPending("hook-sess-1", "PRODUCT-7");
    await ticketGateAssociateCommand({
      sessionId: "hook-sess-1",
      ticketId: "PRODUCT-7",
      ticketTitle: "From hook",
      cwd: "/some/repo",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.revenium.test/v2/api/sessions/hook-sess-1/attribution?teamId=teamHash123",
    );
    const body = JSON.parse(opts.body as string);
    expect(body).not.toHaveProperty("sessionId");
    expect(body.ticketId).toBe("PRODUCT-7");
    expect(body.ticketTitle).toBe("From hook");
    expect(body.subscriberEmail).toBe("dev@example.com");
    expect(await isAssociationPending("hook-sess-1", "PRODUCT-7")).toBe(false);
    const state = await listSessionStatesForCwd("/some/repo");
    expect(state.find((entry) => entry.sessionId === "hook-sess-1")?.ticketId).toBe("PRODUCT-7");
  });

  it("a delayed stale worker cannot overwrite a later ticket or repo hint", async () => {
    writeFakeConfig();
    await setActiveTicket("race-sess", "/race/repo", "PRODUCT-1", "A", "PRODUCT-1");
    await markAssociationPending("race-sess", "PRODUCT-1");

    let rejectFetch: ((reason?: unknown) => void) | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );

    const staleWorker = ticketGateAssociateCommand({
      sessionId: "race-sess",
      ticketId: "PRODUCT-1",
      ticketTitle: "A",
      cwd: "/race/repo",
    });
    await vi.waitFor(() => expect(rejectFetch).toBeTypeOf("function"));

    await setActiveTicket("race-sess", "/race/repo", "BACK-2", "B", "BACK-2");
    rejectFetch?.(new Error("late failure"));
    await staleWorker;

    const session = await listSessionStatesForCwd("/race/repo");
    expect(session.find((entry) => entry.sessionId === "race-sess")?.ticketId).toBe("BACK-2");
    expect((await getRepoTicket("/race/repo"))?.ticketId).toBe("BACK-2");
    expect(await isAssociationPending("race-sess", "PRODUCT-1")).toBe(true);
  });

  it("is a no-op without config (fail-open)", async () => {
    await expect(
      ticketGateAssociateCommand({ sessionId: "s", ticketId: "BACK-1" }),
    ).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never throws even when the POST rejects", async () => {
    writeFakeConfig();
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    await expect(
      ticketGateAssociateCommand({ sessionId: "s", ticketId: "BACK-1" }),
    ).resolves.toBeUndefined();
  });
});
