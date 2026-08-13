import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";

const HOOK_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "claude-code",
  "ticket",
  "hooks",
  "ticket-gate.sh",
);

function hookAvailable(): boolean {
  if (!existsSync(HOOK_PATH)) return false;
  try {
    execSync("which bash", { stdio: "ignore" });
    execSync("which jq", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  if (existsSync(HOOK_PATH)) {
    chmodSync(HOOK_PATH, 0o755);
  }
});

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "revenium-gate-test-"));
});

afterEach(() => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

function runHook(
  stdinJson: object,
  env: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [HOOK_PATH], {
    input: JSON.stringify(stdinJson),
    encoding: "utf-8",
    env: {
      HOME: testHome,
      PATH: process.env.PATH,

      REVENIUM_METERING_BIN: "/nonexistent/revenium-metering",
      ...env,
    },
    timeout: 5000,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

const SESSION_ID = "test-session-123";

function stateDir(): string {
  return join(testHome, ".revenium", "ticket-state");
}

function sessionStateFile(sessionId = SESSION_ID): string {
  return join(stateDir(), `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function associationPendingFile(sessionId: string, ticketId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTicket = ticketId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(stateDir(), `association-pending-${safeSession}-${safeTicket}.txt`);
}

function repoStateFile(cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex");
  return join(stateDir(), `repo-${key}.json`);
}

function pathWithoutHashTools(): string {
  const binDir = join(testHome, "bin-without-hash-tools");
  mkdirSync(binDir, { recursive: true });
  for (const command of ["bash", "cat", "jq", "sed"]) {
    const target = execSync(`command -v ${command}`, {
      encoding: "utf-8",
      shell: "/bin/bash",
    }).trim();
    symlinkSync(target, join(binDir, command));
  }
  return binDir;
}

function writeRepoState(cwd: string, ticketId: string, ticketTitle = "") {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    repoStateFile(cwd),
    JSON.stringify({
      ticketId,
      ticketTitle,
      associatedAt: new Date().toISOString(),
    }),
  );
}

function writeSessionState(
  sessionId: string,
  ticketId: string,
  postedTicketId?: string,
  reason = "",
) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    sessionStateFile(sessionId),
    JSON.stringify({
      ticketId,
      ticketTitle: "",
      reason,
      associatedAt: new Date().toISOString(),
      sessionId,
      ...(postedTicketId ? { postedTicketId } : {}),
    }),
  );
}

function makeGitRepo(branch: string): string {
  const repo = join(testHome, "repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q", { cwd: repo });
  execSync(`git checkout -b "${branch}" -q`, { cwd: repo });
  return repo;
}

function makeStubBinary(): { bin: string; captureFile: string } {
  const captureFile = join(testHome, "associate-capture.txt");
  const bin = join(testHome, "stub-revenium-metering");
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${captureFile}"\n`);
  chmodSync(bin, 0o755);
  return { bin, captureFile };
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path) && readFileSync(path, "utf-8").includes("--ticket")) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(path) && readFileSync(path, "utf-8").includes("--ticket");
}

describe.runIf(hookAvailable())("ticket-gate.sh hook", () => {
  describe("allow cases (empty stdout)", () => {
    it("allows when REVENIUM_TICKET is set, with empty stdout", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_TICKET: "PRODUCT-1234" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });

    it("REVENIUM_TICKET path writes session state with postedTicketId (dedupe flag)", () => {
      runHook({ session_id: SESSION_ID, cwd: testHome }, { REVENIUM_TICKET: "PRODUCT-1234" });
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1234");
      expect(state.postedTicketId).toBe("PRODUCT-1234");
      expect(state.sessionId).toBe(SESSION_ID);
    });

    it("REVENIUM_TICKET path does NOT write repo state (owned by `ticket launch`, not the hook)", () => {
      runHook({ session_id: SESSION_ID, cwd: testHome }, { REVENIUM_TICKET: "PRODUCT-1234" });
      expect(existsSync(repoStateFile(testHome))).toBe(false);
    });

    it("does not re-adopt stale launch env after an in-session switch", () => {
      const launchEnv = {
        REVENIUM_TICKET: "PRODUCT-1234",
        REVENIUM_TICKET_TITLE: "Original launch ticket",
      };

      runHook({ session_id: SESSION_ID, cwd: testHome }, launchEnv);
      expect(JSON.parse(readFileSync(sessionStateFile(), "utf-8")).ticketId).toBe("PRODUCT-1234");

      runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "switch-ticket BACK-42" },
        launchEnv,
      );
      expect(JSON.parse(readFileSync(sessionStateFile(), "utf-8")).ticketId).toBe("BACK-42");

      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "ordinary follow-up prompt" },
        launchEnv,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(JSON.parse(readFileSync(sessionStateFile(), "utf-8")).ticketId).toBe("BACK-42");
    });

    it("allows when REVVIE_AUTONOMOUS is set", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVVIE_AUTONOMOUS: "1" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });

    it("allows when REVENIUM_AUTONOMOUS is set", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_AUTONOMOUS: "1" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });

    it("allows via existing session state", () => {
      writeSessionState(SESSION_ID, "BACK-42", "BACK-42");
      const { exitCode, stdout } = runHook({ session_id: SESSION_ID, cwd: testHome });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });

    it("allows via repo state fallback (resumed session) and writes session state", () => {
      writeRepoState(testHome, "BACK-42");
      const { exitCode, stdout } = runHook({ session_id: "new-session-456", cwd: testHome });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      const state = JSON.parse(readFileSync(sessionStateFile("new-session-456"), "utf-8"));
      expect(state.ticketId).toBe("BACK-42");
    });
  });

  describe("concurrency: repo state never overrides an existing session", () => {
    it("keeps this session's own ticket even when repo state disagrees (no re-adopt)", async () => {
      const { bin, captureFile } = makeStubBinary();

      writeSessionState(SESSION_ID, "PRODUCT-1234", "PRODUCT-1234");

      writeRepoState(testHome, "BACK-99");

      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_METERING_BIN: bin },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");

      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1234");

      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(captureFile)).toBe(false);
    });

    it("a second co-located session keeps its own ticket independent of the first", () => {
      const SESSION_A = "concurrent-session-a";
      const SESSION_B = "concurrent-session-b";
      writeSessionState(SESSION_A, "PRODUCT-1", "PRODUCT-1");
      writeSessionState(SESSION_B, "BACK-2", "BACK-2");
      writeRepoState(testHome, "BACK-2");

      runHook({ session_id: SESSION_A, cwd: testHome });
      runHook({ session_id: SESSION_B, cwd: testHome });

      const stateA = JSON.parse(readFileSync(sessionStateFile(SESSION_A), "utf-8"));
      const stateB = JSON.parse(readFileSync(sessionStateFile(SESSION_B), "utf-8"));
      expect(stateA.ticketId).toBe("PRODUCT-1");
      expect(stateB.ticketId).toBe("BACK-2");
    });

    it("two concurrent sessions, same cwd, different tickets: an in-session switch on one leaves the other untouched", async () => {
      const SESSION_A = "concurrent-session-a";
      const SESSION_B = "concurrent-session-b";
      const { bin, captureFile } = makeStubBinary();
      writeSessionState(SESSION_A, "PRODUCT-1", "PRODUCT-1");
      writeSessionState(SESSION_B, "BACK-2", "BACK-2");

      const { stdout: aStdout } = runHook(
        { session_id: SESSION_A, cwd: testHome, prompt: "switch-ticket BACK-99" },
        { REVENIUM_METERING_BIN: bin },
      );
      const parsed = JSON.parse(aStdout) as { decision?: string; reason?: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("BACK-99");

      expect(await waitForFile(captureFile)).toBe(true);
      const captureAfterA = readFileSync(captureFile, "utf-8").trim().split("\n");

      runHook({ session_id: SESSION_B, cwd: testHome }, { REVENIUM_METERING_BIN: bin });

      const stateA = JSON.parse(readFileSync(sessionStateFile(SESSION_A), "utf-8"));
      const stateB = JSON.parse(readFileSync(sessionStateFile(SESSION_B), "utf-8"));
      expect(stateA.ticketId).toBe("BACK-99");
      expect(stateB.ticketId).toBe("BACK-2");

      expect(captureAfterA[captureAfterA.indexOf("--session-id") + 1]).toBe(SESSION_A);
      expect(captureAfterA[captureAfterA.indexOf("--ticket") + 1]).toBe("BACK-99");
    });
  });

  describe("in-session switch directive (switch-ticket <ID>)", () => {
    it("swallows the directive (decision:block) and adopts the ticket for THIS session", () => {
      const { exitCode, stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "switch-ticket BACK-99",
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("BACK-99");
      expect(parsed.reason).toContain("not sent to the model");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("BACK-99");
    });

    it("does NOT write repo state (session-only, per the concurrency invariant)", () => {
      runHook({ session_id: SESSION_ID, cwd: testHome, prompt: "switch-ticket BACK-99" });
      expect(existsSync(repoStateFile(testHome))).toBe(false);
    });

    it("tolerates surrounding whitespace and mixed case", () => {
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "  Switch-Ticket back-42  ",
      });
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("BACK-42");
    });

    it("supports 'none' with a required reason, kept lowercase", () => {
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "switch-ticket none --reason exploratory spike",
      });
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("none");
      expect(state.reason).toBe("exploratory spike");
    });

    it("rejects 'none' without the required reason", () => {
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "switch-ticket none",
      });
      expect(JSON.parse(stdout).reason).toMatch(/requires a reason/i);
      expect(existsSync(sessionStateFile())).toBe(false);
    });

    it("enforces the configured organization ticket regex", () => {
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "switch-ticket ENG-99" },
        { REVENIUM_TICKET_REGEX: "(PRODUCT|BACK)-[0-9]+" },
      );
      expect(JSON.parse(stdout).reason).toMatch(/does not match/i);
      expect(existsSync(sessionStateFile())).toBe(false);
    });

    it("spawns the detached POST with the real session id", async () => {
      const { bin, captureFile } = makeStubBinary();
      runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "switch-ticket BACK-99" },
        { REVENIUM_METERING_BIN: bin },
      );
      expect(await waitForFile(captureFile)).toBe(true);
      const argv = readFileSync(captureFile, "utf-8").trim().split("\n");
      expect(argv[argv.indexOf("--session-id") + 1]).toBe(SESSION_ID);
      expect(argv[argv.indexOf("--ticket") + 1]).toBe("BACK-99");
    });

    it("passes an opt-out reason to the worker and retains it for retry", async () => {
      const { bin, captureFile } = makeStubBinary();
      runHook(
        {
          session_id: SESSION_ID,
          cwd: testHome,
          prompt: "switch-ticket none --reason exploratory spike",
        },
        { REVENIUM_METERING_BIN: bin },
      );
      expect(await waitForFile(captureFile)).toBe(true);
      const firstArgv = readFileSync(captureFile, "utf-8").trim().split("\n");
      expect(firstArgv[firstArgv.indexOf("--reason") + 1]).toBe("exploratory spike");

      writeFileSync(associationPendingFile(SESSION_ID, "none"), "0");
      rmSync(captureFile, { force: true });
      runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "normal prompt" },
        { REVENIUM_METERING_BIN: bin },
      );
      expect(await waitForFile(captureFile)).toBe(true);
      const retryArgv = readFileSync(captureFile, "utf-8").trim().split("\n");
      expect(retryArgv[retryArgv.indexOf("--reason") + 1]).toBe("exploratory spike");
    });

    it("does NOT trigger on ordinary prose that merely mentions the keyword", () => {
      writeSessionState(SESSION_ID, "PRODUCT-1", "PRODUCT-1");
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "can you explain how switch-ticket BACK-99 differs from the old flow?",
      });
      expect(stdout).toBe("");
    });

    it("does NOT swallow a multiline prompt that starts like a switch directive", () => {
      writeSessionState(SESSION_ID, "PRODUCT-1", "PRODUCT-1");
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "switch-ticket none\n--reason explain how opt-out works",
      });

      expect(stdout).toBe("");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1");
    });

    it("does NOT trigger on a shell-mode-prefixed line (! never reaches the hook anyway, but defensively not matched)", () => {
      writeSessionState(SESSION_ID, "PRODUCT-1", "PRODUCT-1");
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "!switch-ticket BACK-99",
      });
      expect(stdout).toBe("");
    });

    it("is ignored on SessionStart (no prompt field to match against)", () => {
      const { exitCode, stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        hook_event_name: "SessionStart",
        source: "startup",
        prompt: "switch-ticket BACK-99",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");

      expect(existsSync(sessionStateFile())).toBe(false);
    });
  });

  describe("detached attribution POST", () => {
    it("spawns the associate worker with the real session id and ticket", async () => {
      const { bin, captureFile } = makeStubBinary();
      runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_TICKET: "PRODUCT-1234", REVENIUM_METERING_BIN: bin },
      );
      expect(await waitForFile(captureFile)).toBe(true);
      const argv = readFileSync(captureFile, "utf-8").trim().split("\n");
      expect(argv).toContain("ticket-gate");
      expect(argv).toContain("associate");
      expect(argv[argv.indexOf("--session-id") + 1]).toBe(SESSION_ID);
      expect(argv[argv.indexOf("--ticket") + 1]).toBe("PRODUCT-1234");
    });

    it("does NOT re-spawn when the (session, ticket) pair already POSTed", async () => {
      const { bin, captureFile } = makeStubBinary();
      writeSessionState(SESSION_ID, "PRODUCT-1234", "PRODUCT-1234");
      runHook({ session_id: SESSION_ID, cwd: testHome }, { REVENIUM_METERING_BIN: bin });

      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(captureFile)).toBe(false);
    });

    it("skips silently when the metering binary is missing (fail-open)", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_TICKET: "PRODUCT-1234", REVENIUM_METERING_BIN: "/definitely/not/here" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");

      expect(existsSync(sessionStateFile())).toBe(true);
    });

    it("keeps a pending marker when the metering binary is temporarily missing", () => {
      runHook({ session_id: SESSION_ID, cwd: testHome }, { REVENIUM_TICKET: "PRODUCT-1234" });
      expect(existsSync(associationPendingFile(SESSION_ID, "PRODUCT-1234"))).toBe(true);
    });
  });

  describe("auto-associate from branch inference", () => {
    it("auto-associates with a systemMessage notice (default)", () => {
      const repo = makeGitRepo("product-1632-foo");
      const { exitCode, stdout } = runHook({ session_id: SESSION_ID, cwd: repo });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).toContain("PRODUCT-1632");
      expect(parsed.systemMessage).toContain("inferred from branch");
    });

    it("auto-associate writes session state but NOT repo state (hook never writes repo state)", () => {
      const repo = makeGitRepo("feature/BACK-77-fix-thing");
      runHook({ session_id: SESSION_ID, cwd: repo });
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("BACK-77");
      expect(state.cwd).toBe(repo);
      expect(existsSync(repoStateFile(repo))).toBe(false);
    });

    it("auto-associate spawns the detached POST", async () => {
      const { bin, captureFile } = makeStubBinary();
      const repo = makeGitRepo("product-1632-foo");
      runHook({ session_id: SESSION_ID, cwd: repo }, { REVENIUM_METERING_BIN: bin });
      expect(await waitForFile(captureFile)).toBe(true);
      const argv = readFileSync(captureFile, "utf-8").trim().split("\n");
      expect(argv[argv.indexOf("--ticket") + 1]).toBe("PRODUCT-1632");
    });

    it("REVENIUM_TICKET_AUTO_ASSOCIATE=false keeps suggest-in-block behavior", () => {
      const repo = makeGitRepo("product-1632-foo");
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: repo },
        { REVENIUM_TICKET_AUTO_ASSOCIATE: "false", REVENIUM_TICKET_BLOCK_POLICY: "hard-block" },
      );
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("PRODUCT-1632");
      expect(existsSync(sessionStateFile())).toBe(false);
    });

    it("does not infer a branch ticket rejected by the organization regex", () => {
      const repo = makeGitRepo("feature/ENG-99-not-allowed");
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: repo },
        {
          REVENIUM_TICKET_REGEX: "(PRODUCT|BACK)-[0-9]+",
          REVENIUM_TICKET_BLOCK_POLICY: "hard-block",
        },
      );
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).not.toContain("ENG-99");
      expect(existsSync(sessionStateFile())).toBe(false);
    });
  });

  describe("block cases", () => {
    it("blocks when no attribution and no branch inference under hard-block", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_TICKET_BLOCK_POLICY: "hard-block" },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("ticket launch");
      expect(parsed.reason).toContain("switch-ticket");
    });

    it("defaults to remind-only (unset policy): notice, not block", () => {
      const { exitCode, stdout } = runHook({ session_id: SESSION_ID, cwd: testHome });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).toContain("Revenium");
    });
  });

  describe("prompt ticket detection (unattributed session)", () => {
    it("only suggests (no adopt/POST) when no org regex is configured", () => {
      const { exitCode, stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "fix PRODUCT-1634, the button is broken",
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).toContain("PRODUCT-1634");
      expect(parsed.systemMessage).toContain("switch-ticket");
      expect(existsSync(sessionStateFile())).toBe(false);
    });

    it("auto-adopts a prompt ticket when REVENIUM_TICKET_REGEX is configured", () => {
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "fix PRODUCT-1634, the button is broken" },
        { REVENIUM_TICKET_REGEX: "(PRODUCT|BACK|FRONT)-[0-9]+" },
      );
      const parsed = JSON.parse(stdout) as { systemMessage?: string };
      expect(parsed.systemMessage).toContain("Metering against PRODUCT-1634");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1634");
    });

    it("honors an anchored REVENIUM_TICKET_REGEX (anchors stripped for extraction)", () => {
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "fix PRODUCT-1634 now" },
        { REVENIUM_TICKET_REGEX: "^(PRODUCT|BACK)-[0-9]+$" },
      );
      const parsed = JSON.parse(stdout) as { systemMessage?: string };
      expect(parsed.systemMessage).toContain("Metering against PRODUCT-1634");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1634");
    });

    it("lets branch inference take precedence over a prompt ticket", () => {
      const repo = makeGitRepo("product-1632-foo");
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: repo, prompt: "actually this is for PRODUCT-1789" },
        { REVENIUM_TICKET_REGEX: "(PRODUCT|BACK|FRONT)-[0-9]+" },
      );
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1632");
      const parsed = JSON.parse(stdout) as { systemMessage?: string };
      expect(parsed.systemMessage).toContain("inferred from branch");
    });

    it("does not override an already-attributed session (prose ticket ignored)", () => {
      writeSessionState(SESSION_ID, "PRODUCT-1", "PRODUCT-1");
      const { stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        prompt: "also look at BACK-99 while you are here",
      });
      expect(stdout).toBe("");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1");
    });

    it("respects the organization regex and ignores a non-matching ticket", () => {
      const { stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "working on ENG-99 today" },
        { REVENIUM_TICKET_REGEX: "(PRODUCT|BACK)-[0-9]+" },
      );
      const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).not.toContain("ENG-99");
      expect(existsSync(sessionStateFile())).toBe(false);
    });
  });

  describe("missing jq dependency", () => {
    function pathWithoutJq(dirName: string): string {
      const binDir = join(testHome, dirName);
      mkdirSync(binDir, { recursive: true });
      for (const command of ["bash", "cat"]) {
        const target = execSync(`command -v ${command}`, {
          encoding: "utf-8",
          shell: "/bin/bash",
        }).trim();
        symlinkSync(target, join(binDir, command));
      }
      return binDir;
    }

    it("warns visibly and passes the prompt through instead of silently allowing", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "do something" },
        { PATH: pathWithoutJq("bin-without-jq") },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { systemMessage?: string };
      expect(parsed.systemMessage).toContain("jq not found");
    });

    it("stays silent on SessionStart even without jq", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, hook_event_name: "SessionStart" },
        { PATH: pathWithoutJq("bin-without-jq-ss") },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });
  });

  describe("remind-only policy", () => {
    it("allows through with a systemMessage (NOT decision:allow)", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome },
        { REVENIUM_TICKET_BLOCK_POLICY: "remind-only" },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).toContain("Revenium");
    });
  });

  describe("N free prompts policy", () => {
    it("allows first N prompts with systemMessage, then blocks", () => {
      const env = { REVENIUM_TICKET_BLOCK_POLICY: "2" };
      const input = { session_id: SESSION_ID, cwd: testHome };

      const first = JSON.parse(runHook(input, env).stdout) as Record<string, string>;
      expect(first.systemMessage).toContain("1 free prompt");
      expect(first.decision).toBeUndefined();

      const second = JSON.parse(runHook(input, env).stdout) as Record<string, string>;
      expect(second.systemMessage).toContain("0 free prompt");

      const third = JSON.parse(runHook(input, env).stdout) as Record<string, string>;
      expect(third.decision).toBe("block");
    });
  });

  describe("SessionStart event", () => {
    it("outputs NOTHING and exits 0 even when unattributed (would block on prompt)", () => {
      const { exitCode, stdout } = runHook({
        session_id: SESSION_ID,
        cwd: testHome,
        hook_event_name: "SessionStart",
        source: "startup",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    });

    it("reconciles state from repo fallback silently (resume)", () => {
      writeRepoState(testHome, "BACK-42");
      const { exitCode, stdout } = runHook({
        session_id: "resumed-789",
        cwd: testHome,
        hook_event_name: "SessionStart",
        source: "resume",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      const state = JSON.parse(readFileSync(sessionStateFile("resumed-789"), "utf-8"));
      expect(state.ticketId).toBe("BACK-42");
    });

    it("auto-associates from branch silently (no systemMessage on SessionStart)", () => {
      const repo = makeGitRepo("product-1632-foo");
      const { exitCode, stdout } = runHook({
        session_id: SESSION_ID,
        cwd: repo,
        hook_event_name: "SessionStart",
        source: "startup",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      const state = JSON.parse(readFileSync(sessionStateFile(), "utf-8"));
      expect(state.ticketId).toBe("PRODUCT-1632");
    });

    it("spawns the detached POST on SessionStart resume", async () => {
      const { bin, captureFile } = makeStubBinary();
      writeRepoState(testHome, "BACK-42");
      runHook(
        {
          session_id: "resumed-789",
          cwd: testHome,
          hook_event_name: "SessionStart",
          source: "resume",
        },
        { REVENIUM_METERING_BIN: bin },
      );

      return waitForFile(captureFile).then((found) => {
        expect(found).toBe(true);
        const argv = readFileSync(captureFile, "utf-8").trim().split("\n");
        expect(argv[argv.indexOf("--session-id") + 1]).toBe("resumed-789");
        expect(argv[argv.indexOf("--ticket") + 1]).toBe("BACK-42");
      });
    });
  });

  describe("cwd key parity", () => {
    it("matches Node SHA-256 for long cwd paths without suffix collisions", () => {
      const sharedPrefix = join(testHome, "a b", "x".repeat(120));
      const firstCwd = join(sharedPrefix, "first-suffix");
      const secondCwd = join(sharedPrefix, "second-suffix");
      mkdirSync(firstCwd, { recursive: true });
      mkdirSync(secondCwd, { recursive: true });
      writeRepoState(firstCwd, "BACK-1");
      writeRepoState(secondCwd, "BACK-2");

      for (const [sessionId, cwd, ticketId] of [
        ["long-path-first", firstCwd, "BACK-1"],
        ["long-path-second", secondCwd, "BACK-2"],
      ] as const) {
        const { exitCode, stdout } = runHook({ session_id: sessionId, cwd });
        expect(exitCode).toBe(0);
        expect(stdout).toBe("");
        const state = JSON.parse(readFileSync(sessionStateFile(sessionId), "utf-8"));
        expect(state.ticketId).toBe(ticketId);
      }
    });

    it("continues to hard-block when no SHA-256 command is available", () => {
      const { exitCode, stdout } = runHook(
        { session_id: SESSION_ID, cwd: testHome, prompt: "ordinary prompt" },
        { PATH: pathWithoutHashTools(), REVENIUM_TICKET_BLOCK_POLICY: "hard-block" },
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        decision: "block",
      });
    });
  });
});

describe.skipIf(hookAvailable())("ticket-gate.sh hook (skipped — bash/jq not available)", () => {
  it("skipped", () => {
    expect(true).toBe(true);
  });
});
