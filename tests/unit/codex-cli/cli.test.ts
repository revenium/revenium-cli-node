import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/codex-cli/commands/setup.js", () => ({
  setupAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/codex-cli/commands/run.js", () => ({
  runCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/codex-cli/commands/backfill.js", () => ({
  backfillAction: vi.fn().mockResolvedValue(undefined),
}));

import { program } from "../../../src/codex-cli/cli/index.js";
import { setupAction } from "../../../src/codex-cli/commands/setup.js";
import { runCommand } from "../../../src/codex-cli/commands/run.js";
import { backfillAction } from "../../../src/codex-cli/commands/backfill.js";

describe("codex setup CLI options", () => {
  const setup = program.commands.find((command) => command.name() === "setup");

  it("exposes the tool-detail opt-out as a negated flag", () => {
    const option = setup?.options.find((candidate) => candidate.long === "--no-log-tool-details");

    expect(option).toBeDefined();
    expect(option?.negate).toBe(true);
  });

  it("leaves --endpoint unset so the setup wizard can prompt for it", () => {
    const option = setup?.options.find((candidate) => candidate.long === "--endpoint");

    expect(option).toBeDefined();
    expect(option?.defaultValue).toBeUndefined();
  });

  it("names the mechanism that replaces live export", () => {
    const option = setup?.options.find((candidate) => candidate.long === "--no-log-tool-details");

    expect(option?.description).toContain("backfill");
  });
});

describe("codex backfill CLI options", () => {
  const backfill = program.commands.find((command) => command.name() === "backfill");

  it("tells the reader a date-only end date covers the whole day", () => {
    const option = backfill?.options.find((candidate) => candidate.long === "--to");

    expect(option?.description).toContain("whole day");
  });

  it("lets a developer limit an import to chosen projects, or leave some out", () => {
    const names = backfill?.options.map((option) => option.long);

    expect(names).toContain("--project");
    expect(names).toContain("--exclude-project");
  });

  it.each(["--project", "--exclude-project"])("says %s takes a comma-separated list", (long) => {
    const option = backfill?.options.find((candidate) => candidate.long === long);

    expect(option?.description).toContain("comma-separated");
  });
});

describe("codex backfill CLI — project limit wiring", () => {
  beforeEach(() => {
    vi.mocked(backfillAction).mockClear();
  });

  async function runBackfill(args: string[]) {
    await program.parseAsync(["backfill", ...args], { from: "user" });
    return vi.mocked(backfillAction).mock.calls[0][0];
  }

  it("carries the named projects through to the import", async () => {
    expect((await runBackfill(["--project", "clientA-app,clientB-app"]))?.project).toBe(
      "clientA-app,clientB-app",
    );
  });

  it("carries the excluded projects through to the import", async () => {
    expect((await runBackfill(["--exclude-project", "clientB-app"]))?.excludeProject).toBe(
      "clientB-app",
    );
  });

  it("leaves both unset when neither flag is given", async () => {
    const options = await runBackfill([]);

    expect(options?.project).toBeUndefined();
    expect(options?.excludeProject).toBeUndefined();
  });
});

describe("codex setup CLI — opt-out wiring", () => {
  beforeEach(() => {
    vi.mocked(setupAction).mockClear();
  });

  async function runSetup(args: string[]) {
    await program.parseAsync(["setup", "--api-key", "hak_test_key123", ...args], { from: "user" });
    return vi.mocked(setupAction).mock.calls[0][0];
  }

  it("turns the flag into the opt-out the setup command acts on", async () => {
    expect((await runSetup(["--no-log-tool-details"]))?.logToolDetails).toBe(false);
  });

  it("leaves the setting unset when the flag is absent", async () => {
    expect((await runSetup([]))?.logToolDetails).toBeUndefined();
  });

  it("hands the setup command no endpoint when the flag is absent, so it can prompt", async () => {
    expect((await runSetup([]))?.endpoint).toBeUndefined();
  });
});

describe("codex run CLI", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockClear();
  });

  it("forwards the arguments Codex owns, flags included", async () => {
    await program.parseAsync(["run", "--", "--version", "--unknown-codex-flag"], { from: "user" });

    expect(runCommand).toHaveBeenCalledWith(["--version", "--unknown-codex-flag"], {
      configPath: undefined,
    });
  });

  it("carries the config path chosen at setup through to the launcher", async () => {
    await program.parseAsync(["run", "--config-path", "/custom/config.toml", "--", "--version"], {
      from: "user",
    });

    expect(runCommand).toHaveBeenCalledWith(["--version"], {
      configPath: "/custom/config.toml",
    });
  });

  it.each(["--version", "--help", "-h"])(
    "forwards %s to Codex instead of answering it itself",
    async (flag) => {
      await program.parseAsync(["run", flag], { from: "user" });

      expect(runCommand).toHaveBeenCalledWith([flag], { configPath: undefined });
    },
  );

  it("names the wrapper mechanism in its description", () => {
    const run = program.commands.find((command) => command.name() === "run");

    expect(run?.description()).toContain("process environment");
  });
});
