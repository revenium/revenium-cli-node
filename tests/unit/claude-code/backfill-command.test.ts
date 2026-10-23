import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OTLPLogsPayload } from "../../../src/_core/types/index.js";
import type { ClaudeCodeConfig } from "../../../src/claude-code/config/loader.js";

const homeState = vi.hoisted(() => ({ dir: "" }));
const managedState = vi.hoisted(() => ({ content: null as string | null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: actual, homedir: () => homeState.dir || actual.homedir() };
});

// The managed settings path is an absolute OS location with no environment override, so the real
// file would otherwise decide the outcome of these tests on a managed machine.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (!String(args[0]).endsWith("managed-settings.json")) return actual.readFile(...args);
      if (managedState.content !== null) return Promise.resolve(managedState.content);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
  };
});

vi.mock("../../../src/claude-code/config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendLogsWithResult: vi.fn(),
}));

vi.mock("ora", () => ({
  default: () => {
    const spinner = {
      text: "",
      start: () => spinner,
      succeed: () => spinner,
      fail: () => spinner,
      warn: () => spinner,
      stop: () => spinner,
    };
    return spinner;
  },
}));

import {
  backfillCommand,
  type BackfillOptions,
} from "../../../src/claude-code/commands/backfill.js";
import { loadConfig } from "../../../src/claude-code/config/loader.js";
import { sendLogsWithResult } from "../../../src/_core/api/otlp-client.js";

const SKILL_NAME = "acme-internal:merger-due-diligence";

const config: ClaudeCodeConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
};

interface SessionLineOptions {
  caller?: { type: string };
  cwd?: string;
  sessionId?: string;
}

function sessionLine({ caller, cwd, sessionId = "session-abc" }: SessionLineOptions = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    cwd,
    requestId: `req_${sessionId}`,
    timestamp: "2024-06-01T12:00:00.000Z",
    costUSD: 0.1234,
    message: {
      id: `msg_${sessionId}`,
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "tool_use", name: "Skill", input: { skill: SKILL_NAME }, caller }],
    },
  });
}

async function writeClaudeSettings(logToolDetails?: string): Promise<void> {
  const configDir = join(homeState.dir, ".claude");
  await mkdir(configDir, { recursive: true });
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  if (logToolDetails !== undefined) {
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ env: { OTEL_LOG_TOOL_DETAILS: logToolDetails } }),
    );
  }
}

function sentPayload(): OTLPLogsPayload {
  return vi.mocked(sendLogsWithResult).mock.calls[0][2];
}

beforeEach(async () => {
  vi.clearAllMocks();
  homeState.dir = await mkdtemp(join(tmpdir(), "claude-backfill-"));
  vi.stubEnv("REVENIUM_STARTUP_STAGGER_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(sendLogsWithResult).mockResolvedValue({ success: true });

  const projectDir = join(homeState.dir, ".claude", "projects", "acme");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "session-abc.jsonl"), sessionLine() + "\n");
});

afterEach(async () => {
  managedState.content = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(homeState.dir, { recursive: true, force: true });
});

describe("backfillCommand — tool-details opt-out", () => {
  it("sends no skill name when Claude Code's settings carry the opt-out", async () => {
    await writeClaudeSettings("0");

    await backfillCommand();

    expect(JSON.stringify(sentPayload())).not.toContain(SKILL_NAME);
  });

  it("sends the skill name when Claude Code's settings carry no opt-out", async () => {
    await writeClaudeSettings();

    await backfillCommand();

    expect(JSON.stringify(sentPayload())).toContain(SKILL_NAME);
  });

  it("lets Claude Code's settings override the Revenium configuration", async () => {
    await writeClaudeSettings("0");
    vi.mocked(loadConfig).mockResolvedValue({ ...config, logToolDetails: true });

    await backfillCommand();

    expect(JSON.stringify(sentPayload())).not.toContain(SKILL_NAME);
  });

  it("reports the withholding on a dry run, before anything is sent", async () => {
    await writeClaudeSettings("0");

    await backfillCommand({ dryRun: true });

    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("Withholding skill names"))).toBe(true);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });

  it("sends no skill name when a settings file cannot be read", async () => {
    await writeClaudeSettings();
    managedState.content = "{ not json";
    vi.mocked(loadConfig).mockResolvedValue({ ...config, logToolDetails: true });

    await backfillCommand();

    expect(JSON.stringify(sentPayload())).not.toContain(SKILL_NAME);
  });
});

describe("backfillCommand — the transcripts folder follows CLAUDE_CONFIG_DIR", () => {
  it("imports transcripts that exist only under the override", async () => {
    await rm(join(homeState.dir, ".claude"), { recursive: true, force: true });
    const relocated = join(homeState.dir, "relocated");
    await mkdir(join(relocated, "projects", "acme"), { recursive: true });
    await writeFile(join(relocated, "projects", "acme", "sess-1.jsonl"), sessionLine() + "\n");
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);

    await backfillCommand();

    expect(sendLogsWithResult).toHaveBeenCalled();
    expect(JSON.stringify(sentPayload())).toContain("session-abc");
  });

  it("names the variable when the override holds no transcripts, and still exits 1", async () => {
    await rm(join(homeState.dir, ".claude"), { recursive: true, force: true });
    const empty = join(homeState.dir, "empty");
    await mkdir(empty, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", empty);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(backfillCommand()).rejects.toThrow("process.exit");

    const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes(join(empty, "projects")))).toBe(true);
    expect(lines.some((line) => line.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("imports transcripts from ~/.claude/projects when the variable is unset", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);

    await backfillCommand();

    expect(sendLogsWithResult).toHaveBeenCalled();
    expect(JSON.stringify(sentPayload())).toContain("session-abc");
  });
});

describe("backfillCommand — which projects an import carries", () => {
  const CLIENT_A = "/Users/dev/clientA-app";
  const CLIENT_B = "/Users/dev/clientB-app";

  async function writeSessions(sessions: [string, string, string][]): Promise<void> {
    await writeClaudeSettings();
    const projects = join(homeState.dir, ".claude", "projects");
    await rm(join(projects, "acme"), { recursive: true, force: true });

    for (const [folder, cwd, sessionId] of sessions) {
      await mkdir(join(projects, folder), { recursive: true });
      await writeFile(
        join(projects, folder, `${sessionId}.jsonl`),
        sessionLine({ cwd, sessionId }),
      );
    }
  }

  function writeTwoClients(): Promise<void> {
    return writeSessions([
      ["-Users-dev-clientA-app", CLIENT_A, "sess-clientA"],
      ["-Users-dev-clientB-app", CLIENT_B, "sess-clientB"],
    ]);
  }

  function writeClientsSharingFolderName(): Promise<void> {
    return writeSessions([
      ["-Users-dev-clientA-app-apps-web", `${CLIENT_A}/apps/web`, "sess-clientA-web"],
      ["-Users-dev-clientB-app-apps-web", `${CLIENT_B}/apps/web`, "sess-clientB-web"],
    ]);
  }

  function loggedLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
  }

  function sentSessionIds(): string[] {
    return vi
      .mocked(sendLogsWithResult)
      .mock.calls.flatMap(([, , payload]) =>
        payload.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) =>
            scope.logRecords.flatMap((record) =>
              record.attributes
                .filter((attribute) => attribute.key === "session.id")
                .map((attribute) => String(attribute.value.stringValue)),
            ),
          ),
        ),
      );
  }

  async function expectExitCode1(options: BackfillOptions): Promise<void> {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(backfillCommand(options)).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  }

  it("names every project it found, with a record count, before anything is sent", async () => {
    await writeTwoClients();

    await backfillCommand({ dryRun: true });

    const lines = loggedLines();
    expect(lines.some((line) => line.includes("Projects:"))).toBe(true);
    expect(lines.some((line) => line.includes(CLIENT_A) && line.includes("1 record(s)"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes(CLIENT_B) && line.includes("1 record(s)"))).toBe(
      true,
    );
    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });

  it("sends no record of another client's project when the import names one project", async () => {
    await writeTwoClients();

    await backfillCommand({ project: "clientA-app" });

    expect(sentSessionIds()).not.toContain("sess-clientB");
    expect(sentSessionIds()).toContain("sess-clientA");
  });

  it("sends no record of an excluded project", async () => {
    await writeTwoClients();

    await backfillCommand({ excludeProject: CLIENT_B });

    expect(sentSessionIds()).not.toContain("sess-clientB");
    expect(sentSessionIds()).toContain("sess-clientA");
  });

  it("names the project it sent, with a record count, on a run that is not a preview", async () => {
    await writeTwoClients();

    await backfillCommand({ project: "clientA-app" });

    const lines = loggedLines();
    expect(lines.some((line) => line.includes("Projects:"))).toBe(true);
    expect(lines.some((line) => line.includes(CLIENT_A) && line.includes("1 record(s)"))).toBe(
      true,
    );
    expect(sendLogsWithResult).toHaveBeenCalled();
  });

  it("marks the projects it is leaving out in the listing it prints", async () => {
    await writeTwoClients();

    await backfillCommand({ project: "clientA-app" });

    expect(loggedLines().some((line) => line.includes(CLIENT_B) && line.includes("excluded"))).toBe(
      true,
    );
  });

  it("sends every project when neither option is given", async () => {
    await writeTwoClients();

    await backfillCommand();

    expect(sentSessionIds()).toEqual(expect.arrayContaining(["sess-clientA", "sess-clientB"]));
  });

  it("sends nothing and exits 1 when the named project matches none", async () => {
    await writeTwoClients();

    await expectExitCode1({ project: "clientC-app" });
  });

  it("sends nothing and exits 1 when the excluded project matches none", async () => {
    await writeTwoClients();

    await expectExitCode1({ excludeProject: "clientC-app" });
  });

  it("sends no client's records when the named folder belongs to more than one project", async () => {
    await writeClientsSharingFolderName();

    await expectExitCode1({ project: "web" });
  });

  it("exits 1 on a project that matches none even when the window holds no record", async () => {
    await writeTwoClients();

    await expectExitCode1({ since: "2099-01-01", project: "clientA-app" });
  });

  it("sends no record of a session run from a subdirectory of an excluded project", async () => {
    await writeTwoClients();
    const projects = join(homeState.dir, ".claude", "projects");
    await mkdir(join(projects, "-Users-dev-clientB-app-packages-api"), { recursive: true });
    await writeFile(
      join(projects, "-Users-dev-clientB-app-packages-api", "sess-clientB-api.jsonl"),
      sessionLine({ cwd: `${CLIENT_B}/packages/api`, sessionId: "sess-clientB-api" }),
    );

    await backfillCommand({ excludeProject: CLIENT_B });

    expect(sentSessionIds()).not.toContain("sess-clientB-api");
    expect(sentSessionIds()).toContain("sess-clientA");
  });

  it("sends no record whose project could not be read once a project is excluded", async () => {
    await writeTwoClients();
    await writeFile(
      join(homeState.dir, ".claude", "projects", "-Users-dev-clientA-app", "sess-nocwd.jsonl"),
      sessionLine({ sessionId: "sess-nocwd" }),
    );

    await backfillCommand({ excludeProject: CLIENT_B });

    expect(sentSessionIds()).not.toContain("sess-nocwd");
    expect(sentSessionIds()).toContain("sess-clientA");
  });

  it("sends nothing when every project it found is excluded", async () => {
    await writeTwoClients();

    await backfillCommand({ excludeProject: `${CLIENT_A},${CLIENT_B}` });

    expect(sendLogsWithResult).not.toHaveBeenCalled();
  });
});

describe("backfillCommand — skill origin of an imported session", () => {
  async function importSession(caller?: {
    type: string;
  }): Promise<Array<{ key: string; value: { stringValue?: string } }>> {
    await writeClaudeSettings();
    await writeFile(
      join(homeState.dir, ".claude", "projects", "acme", "session-abc.jsonl"),
      sessionLine({ caller }) + "\n",
    );

    await backfillCommand();

    const activation = sentPayload().resourceLogs[0].scopeLogs[0].logRecords.find(
      (record) => record.body.stringValue === "claude_code.skill_activated",
    );
    expect(activation).toBeDefined();
    return activation!.attributes;
  }

  it("marks a model-started plugin skill as proactive and claims no source", async () => {
    const attributes = await importSession({ type: "direct" });

    expect(attributes.find((attribute) => attribute.key === "skill.name")?.value.stringValue).toBe(
      SKILL_NAME,
    );
    expect(
      attributes.find((attribute) => attribute.key === "invocation_trigger")?.value.stringValue,
    ).toBe("claude-proactive");
    expect(attributes.some((attribute) => attribute.key === "skill.source")).toBe(false);
  });

  it("claims no trigger and no source when the session records no caller", async () => {
    const attributes = await importSession();

    expect(attributes.some((attribute) => attribute.key === "invocation_trigger")).toBe(false);
    expect(attributes.some((attribute) => attribute.key === "skill.source")).toBe(false);
  });
});
