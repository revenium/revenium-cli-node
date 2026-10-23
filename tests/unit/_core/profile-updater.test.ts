import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = { dir: "" };

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir || actual.homedir() };
});

import {
  updateShellProfile,
  isProfileConfigured,
  removeShellProfileConfig,
} from "../../../src/_core/shell/profile-updater.js";

const MARKER = "revenium-gemini-cli-metering";
const WRAPPER = 'gemini() {\n    revenium-gemini run -- "$@"\n}';

const updaterConfig = {
  markerName: MARKER,
  getSourceCommand: () => WRAPPER,
  getConfigFilePath: () => "/tmp/.gemini/revenium.env",
  pruneOtherProfiles: true,
};

const legacyBlock = [
  `# >>> ${MARKER} >>>`,
  'if [ -f "$HOME/.gemini/revenium.env" ]; then',
  '    source "$HOME/.gemini/revenium.env"',
  "fi",
  `# <<< ${MARKER} <<<`,
].join("\n");

let home: string;

async function writeProfile(relativePath: string, content: string): Promise<string> {
  const path = join(home, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
  return path;
}

describe("updateShellProfile", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "profile-updater-"));
    homeState.dir = home;
    vi.stubEnv("SHELL", "/bin/zsh");
  });

  afterEach(async () => {
    homeState.dir = "";
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("removes a stale block left in the profile of a shell it is not configuring", async () => {
    const bashrc = await writeProfile(".bashrc", `export PATH=$PATH\n${legacyBlock}\n`);
    await writeProfile(".zshrc", "export PATH=$PATH\n");

    await updateShellProfile(updaterConfig);

    const content = await readFile(bashrc, "utf-8");
    expect(content).not.toContain(MARKER);
    expect(content).toContain("export PATH=$PATH");
  });

  it("removes a stale block from the fish profile too", async () => {
    const fishConfig = await writeProfile(".config/fish/config.fish", `${legacyBlock}\n`);
    await writeProfile(".zshrc", "");

    await updateShellProfile(updaterConfig);

    expect(await readFile(fishConfig, "utf-8")).not.toContain(MARKER);
  });

  it("keeps blocks of other integrations in the pruned profile", async () => {
    const otherBlock = [
      "# >>> revenium-metering >>>",
      'source "$HOME/.claude/revenium.env"',
      "# <<< revenium-metering <<<",
    ].join("\n");
    const bashrc = await writeProfile(".bashrc", `${otherBlock}\n${legacyBlock}\n`);
    await writeProfile(".zshrc", "");

    await updateShellProfile(updaterConfig);

    expect(await readFile(bashrc, "utf-8")).toContain("revenium-metering");
  });

  it("backs the pruned profile up before rewriting it", async () => {
    await writeProfile(".bashrc", `${legacyBlock}\n`);
    await writeProfile(".zshrc", "");

    await updateShellProfile(updaterConfig);

    const { readdir } = await import("node:fs/promises");
    const backups = (await readdir(home)).filter((f) => f.startsWith(".bashrc.revenium-backup-"));
    expect(backups).toHaveLength(1);
  });

  it("leaves other profiles untouched when pruning is not requested", async () => {
    const bashrc = await writeProfile(".bashrc", `${legacyBlock}\n`);
    await writeProfile(".zshrc", "");

    await updateShellProfile({ ...updaterConfig, pruneOtherProfiles: false });

    expect(await readFile(bashrc, "utf-8")).toContain(MARKER);
  });

  it("installs the wrapper even when another profile cannot be cleaned up", async () => {
    const zshrc = await writeProfile(".zshrc", "");
    const bashrc = await writeProfile(".bashrc", `${legacyBlock}\n`);
    await chmod(bashrc, 0o000);

    const result = await updateShellProfile(updaterConfig);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Could not clean up other shell profiles");
    expect(await readFile(zshrc, "utf-8")).toContain(WRAPPER);

    await chmod(bashrc, 0o600);
  });

  it("writes the wrapper into the profile of the detected shell", async () => {
    const zshrc = await writeProfile(".zshrc", "");

    await updateShellProfile(updaterConfig);

    expect(await readFile(zshrc, "utf-8")).toContain(WRAPPER);
  });
});

describe("isProfileConfigured", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "profile-configured-"));
    homeState.dir = home;
    vi.stubEnv("SHELL", "/bin/zsh");
  });

  afterEach(async () => {
    homeState.dir = "";
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("reports the wrapper as installed when the block contains the launcher", async () => {
    await writeProfile(".zshrc", `# >>> ${MARKER} >>>\n${WRAPPER}\n# <<< ${MARKER} <<<\n`);

    expect(await isProfileConfigured(MARKER, "revenium-gemini run --")).toBe(true);
  });

  it("reports a pre-change block that only sources the env file as not configured", async () => {
    await writeProfile(".zshrc", `${legacyBlock}\n`);

    expect(await isProfileConfigured(MARKER, "revenium-gemini run --")).toBe(false);
  });

  it("ignores the launcher when it appears outside the managed block", async () => {
    await writeProfile(".zshrc", `alias g='revenium-gemini run --'\n`);

    expect(await isProfileConfigured(MARKER, "revenium-gemini run --")).toBe(false);
  });

  it("returns false when the profile does not exist", async () => {
    expect(await isProfileConfigured(MARKER, "revenium-gemini run --")).toBe(false);
  });
});

describe("removeShellProfileConfig", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "profile-remove-"));
    homeState.dir = home;
    vi.stubEnv("SHELL", "/bin/zsh");
  });

  afterEach(async () => {
    homeState.dir = "";
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("strips the block from every known shell profile, whichever shell is in use", async () => {
    const bashrc = await writeProfile(".bashrc", `${legacyBlock}\n`);
    const zshrc = await writeProfile(".zshrc", `${legacyBlock}\n`);
    const fishConfig = await writeProfile(".config/fish/config.fish", `${legacyBlock}\n`);

    const removed = await removeShellProfileConfig(MARKER);

    expect(removed.sort()).toEqual([bashrc, fishConfig, zshrc].sort());
    for (const path of [bashrc, zshrc, fishConfig]) {
      expect(await readFile(path, "utf-8")).not.toContain(MARKER);
    }
  });

  it("leaves the surrounding profile content byte-identical", async () => {
    const surrounding = "export PATH=$PATH:/opt/bin\nalias ll='ls -la'\n";
    const zshrc = await writeProfile(".zshrc", `${surrounding}${legacyBlock}\n`);

    await removeShellProfileConfig(MARKER);

    expect(await readFile(zshrc, "utf-8")).toBe(surrounding);
  });

  it("backs up each profile it rewrites", async () => {
    await writeProfile(".zshrc", `${legacyBlock}\n`);

    await removeShellProfileConfig(MARKER);

    const { readdir } = await import("node:fs/promises");
    const backups = (await readdir(home)).filter((f) => f.startsWith(".zshrc.revenium-backup-"));
    expect(backups).toHaveLength(1);
  });

  it("gives the backup the same permissions as the profile it copies", async () => {
    const zshrc = await writeProfile(".zshrc", `${legacyBlock}\n`);
    await chmod(zshrc, 0o644);

    await removeShellProfileConfig(MARKER);

    const { readdir, stat } = await import("node:fs/promises");
    const backup = (await readdir(home)).find((f) => f.startsWith(".zshrc.revenium-backup-"));
    expect((await stat(join(home, backup as string))).mode & 0o777).toBe(0o644);
  });

  it("reports nothing removed when no profile carries the block", async () => {
    await writeProfile(".zshrc", "export PATH=$PATH\n");

    expect(await removeShellProfileConfig(MARKER)).toEqual([]);
  });

  it("clears the profiles it can read when another one is unreadable", async () => {
    const zshrc = await writeProfile(".zshrc", `${legacyBlock}\n`);
    // A directory fails readFile with EISDIR for every user, including root, which ignores the
    // permission bits a chmod-based stand-in would rely on.
    await mkdir(join(home, ".bashrc"), { recursive: true });

    const removed = await removeShellProfileConfig(MARKER);

    expect(removed).toEqual([zshrc]);
    expect(await readFile(zshrc, "utf-8")).not.toContain(MARKER);
  });
});
