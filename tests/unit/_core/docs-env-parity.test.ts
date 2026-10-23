import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { program as CLAUDE_PROGRAM } from "../../../src/claude-code/cli/index.js";
import { program as GEMINI_PROGRAM } from "../../../src/gemini-cli/cli/index.js";
import { program as CURSOR_PROGRAM } from "../../../src/cursor/cli/index.js";
import { program as COPILOT_PROGRAM } from "../../../src/copilot/cli/index.js";
import { program as CODEX_PROGRAM } from "../../../src/codex-cli/cli/index.js";
import { ENV_VARS as CLAUDE_ENV_VARS } from "../../../src/claude-code/constants.js";
import { ENV_VARS as GEMINI_ENV_VARS } from "../../../src/gemini-cli/constants.js";
import {
  ENV_KEYS as CURSOR_ENV_KEYS,
  LEGACY_CURSOR_API_KEY,
} from "../../../src/cursor/constants.js";
import { ENV_KEYS as COPILOT_ENV_KEYS } from "../../../src/copilot/constants.js";
import { CODEX_ENV_KEYS } from "../../../src/codex-cli/constants.js";
import { CONFIG_FILE_MODE } from "../../../src/_core/constants.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const SRC_DIR = join(REPO_ROOT, "src");

const RETIRED_VARIABLES = ["REVENIUM_EMAIL", "REVENIUM_COST_MULTIPLIER"];

const KEY_CONSTANTS: Record<string, string>[] = [
  CLAUDE_ENV_VARS,
  GEMINI_ENV_VARS,
  CURSOR_ENV_KEYS,
  COPILOT_ENV_KEYS,
  CODEX_ENV_KEYS,
];

const KNOWN_CONFIG_KEYS = new Set(KEY_CONSTANTS.flatMap((keys) => Object.values(keys)));

const CONSTANT_NAMES_BY_VALUE = KEY_CONSTANTS.reduce((names, keys) => {
  for (const [name, value] of Object.entries(keys)) {
    names.set(value, [...(names.get(value) ?? []), name]);
  }
  return names;
}, new Map<string, string[]>());

const ENV_READING_HELPERS = ["parsePositiveInt", "parseNonNegativeInt", "parsePositiveFloat"];

const FILE_ONLY_KEYS = [
  "REVENIUM_CURSOR_API_KEY",
  "CURSOR_SUBSCRIPTION_TIER",
  "REVENIUM_SYNC_INTERVAL_MS",
];

const LEGACY_CURSOR_KEY_MENTION = new RegExp(`(?<![A-Z_])${LEGACY_CURSOR_API_KEY}`);

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

const SHIPPED_BINS = Object.keys(
  (JSON.parse(readRepoFile("package.json")) as { bin: Record<string, string> }).bin,
).sort();

function readSourceTree(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? readSourceTree(path) : readFileSync(path, "utf-8");
    })
    .join("\n");
}

function extractSection(markdown: string, heading: string, terminator = /\n#{2,3} /): string {
  const marker = `${heading}\n`;
  const start = markdown.indexOf(marker);
  expect(start, `section "${heading}" is missing from README.md`).toBeGreaterThan(-1);
  const body = markdown.slice(start + marker.length);
  const end = body.search(terminator);
  return end === -1 ? body : body.slice(0, end);
}

function extractTableVariables(section: string): string[] {
  const matches = section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`/gm);
  return [...new Set([...matches].map((match) => match[1]))];
}

const PROGRAMS_BY_BIN: Record<string, Command> = {
  "revenium-metering": CLAUDE_PROGRAM,
  "revenium-gemini": GEMINI_PROGRAM,
  "revenium-cursor": CURSOR_PROGRAM,
  "revenium-copilot": COPILOT_PROGRAM,
  "revenium-codex": CODEX_PROGRAM,
};

interface DocumentedCommand {
  toolHeading: string;
  commandHeading: string;
  bin: string | undefined;
  path: string[];
  flags: string[];
}

const COMMAND_TOKEN = /^[a-z][a-z0-9-]*$/;

function headingLine(section: string): string {
  return section.split("\n")[0].trim();
}

function extractBacktickedToken(heading: string): string | undefined {
  return /`([a-z][a-z0-9-]*)`/.exec(heading)?.[1];
}

function extractCommandPath(heading: string): string[] {
  const tokens = heading.replace(/`/g, " ").trim().split(/\s+/);
  const firstNonCommand = tokens.findIndex((token) => !COMMAND_TOKEN.test(token));
  return firstNonCommand === -1 ? tokens : tokens.slice(0, firstNonCommand);
}

function extractTableFlags(section: string): string[] {
  const firstCells = [...section.matchAll(/^\|([^|\n]*)\|/gm)].map((match) => match[1]);
  const flags = firstCells.flatMap((cell) => [...cell.matchAll(/--[A-Za-z][\w-]*/g)].flat());
  return [...new Set(flags)];
}

function resolveCommand(program: Command | undefined, path: string[]): Command | undefined {
  return path.reduce<Command | undefined>(
    (parent, name) => parent?.commands.find((candidate) => candidate.name() === name),
    program,
  );
}

function commandReferenceSections(markdown: string): string[] {
  return extractSection(markdown, "## Command Reference", /\n## /).split(/^### /m).slice(1);
}

function extractStrayHeadings(markdown: string): string[] {
  return commandReferenceSections(markdown)
    .flatMap((toolSection) => toolSection.split(/^#### /m))
    .flatMap((section) => section.split("\n").slice(1))
    .filter((line) => /^#{2,6}\s/.test(line));
}

function extractDocumentedCommands(markdown: string): DocumentedCommand[] {
  return commandReferenceSections(markdown).flatMap((toolSection) => {
    const [toolSectionHeading, ...commandSections] = toolSection.split(/^#### /m);
    const toolHeading = headingLine(toolSectionHeading);
    const bin = extractBacktickedToken(toolHeading);

    return commandSections.map((commandSection) => {
      const commandHeading = headingLine(commandSection);
      return {
        toolHeading,
        commandHeading,
        bin,
        path: extractCommandPath(commandHeading),
        flags: extractTableFlags(commandSection),
      };
    });
  });
}

const README = readRepoFile("README.md");
const ENV_EXAMPLE = readRepoFile(".env.example");
const SOURCES = readSourceTree(SRC_DIR);

function readsThroughKeyConstant(variable: string): boolean {
  return (CONSTANT_NAMES_BY_VALUE.get(variable) ?? []).some((name) =>
    new RegExp(`process\\.env\\[[A-Za-z_][A-Za-z0-9_]*\\.${name}\\]`).test(SOURCES),
  );
}

function readsThroughEnvHelper(variable: string): boolean {
  return ENV_READING_HELPERS.some((helper) => SOURCES.includes(`${helper}("${variable}"`));
}

function isReadFromProcessEnv(variable: string): boolean {
  return (
    SOURCES.includes(`process.env.${variable}`) ||
    SOURCES.includes(`process.env["${variable}"]`) ||
    readsThroughKeyConstant(variable) ||
    readsThroughEnvHelper(variable)
  );
}

describe("Getting Started sends the customer to each tool's setup", () => {
  const section = extractSection(README, "### Configuration");
  it.each(SHIPPED_BINS)("names `%s setup`", (bin) => {
    expect(section).toContain(`${bin} setup`);
  });

  it("does not tell the customer to create a project .env", () => {
    expect(section).not.toMatch(/create a[^\n]*\.env/i);
  });

  it("shows no .env snippet to copy", () => {
    expect(section).not.toContain("```env");
  });
});

describe("README configuration keys mirror the key constants", () => {
  const documented = extractTableVariables(extractSection(README, "### Configuration File Keys"));

  it("documents at least the shared Revenium keys", () => {
    expect(documented).toContain(CURSOR_ENV_KEYS.REVENIUM_API_KEY);
    expect(documented).toContain(CURSOR_ENV_KEYS.SUBSCRIBER_EMAIL);
  });

  it.each(documented)("%s is defined by a tool's key constant", (variable) => {
    expect(KNOWN_CONFIG_KEYS).toContain(variable);
  });
});

describe("README environment variables are read from process.env", () => {
  const documented = extractTableVariables(extractSection(README, "### Environment Variables"));

  it.each(documented)("%s is read from the process environment", (variable) => {
    expect(isReadFromProcessEnv(variable)).toBe(true);
  });

  it.each(FILE_ONLY_KEYS)("rejects the file-only key %s", (variable) => {
    expect(isReadFromProcessEnv(variable)).toBe(false);
  });
});

describe("README promises owner-only permissions for every credential file", () => {
  const rows = [
    ...extractSection(README, "### Configuration File Locations").matchAll(
      /^\|\s*[^|]+\|\s*`([^`]+)`[^|]*\|\s*([^|]+?)\s*\|$/gm,
    ),
  ];

  it("lists both Codex files", () => {
    const paths = rows.map(([, path]) => path);
    expect(paths).toContain("~/.codex/config.toml");
    expect(paths).toContain("~/.codex/revenium.env");
  });

  it.each(rows.map(([, path, permissions]) => [path, permissions]))(
    "%s is documented as owner read/write",
    (_path, permissions) => {
      expect(permissions).toBe(
        `0o${CONFIG_FILE_MODE.toString(8).padStart(3, "0")} (owner read/write)`,
      );
    },
  );
});

describe("the retired Cursor admin key name is gone from the documentation", () => {
  it.each(["README.md", "TESTING.md"])("%s names only the Revenium-prefixed key", (file) => {
    expect(readRepoFile(file)).not.toMatch(LEGACY_CURSOR_KEY_MENTION);
  });
});

describe("retired variables are gone from the documentation", () => {
  it.each(RETIRED_VARIABLES)("%s is absent from README.md", (variable) => {
    expect(README).not.toContain(variable);
  });

  it.each(RETIRED_VARIABLES)("%s is absent from .env.example", (variable) => {
    expect(ENV_EXAMPLE).not.toContain(variable);
  });

  it.each(RETIRED_VARIABLES)("%s is defined by no tool's key constant", (variable) => {
    expect(KNOWN_CONFIG_KEYS).not.toContain(variable);
  });
});

describe("README command options are accepted by the matching tool", () => {
  const documented = extractDocumentedCommands(README);

  it.each(documented.map((entry) => [entry.commandHeading, entry] as const))(
    "heading %s names a tool and a command",
    (_heading, entry) => {
      expect(entry.bin, `tool heading "${entry.toolHeading}" names no bin`).toBeDefined();
      expect(
        entry.path,
        `command heading "${entry.commandHeading}" names no command`,
      ).not.toHaveLength(0);
    },
  );

  it("documents every tool that ships a program", () => {
    expect([...new Set(documented.map((entry) => entry.bin))].sort()).toEqual(SHIPPED_BINS);
  });

  it("maps every tool that ships a program to its CLI", () => {
    expect(Object.keys(PROGRAMS_BY_BIN).sort()).toEqual(SHIPPED_BINS);
  });

  it("writes every command heading at the documented level", () => {
    expect(extractStrayHeadings(README)).toEqual([]);
  });

  it.each(documented.map((entry) => [entry.bin, entry.path.join(" "), entry] as const))(
    "%s %s accepts its documented options",
    (_bin, commandPath, entry) => {
      const program = entry.bin === undefined ? undefined : PROGRAMS_BY_BIN[entry.bin];
      const command = resolveCommand(program, entry.path);
      expect(command, `${entry.bin} defines no command "${commandPath}"`).toBeDefined();

      const accepted = command?.options.map((option) => option.long) ?? [];
      for (const flag of entry.flags) {
        expect(accepted, `${entry.bin} ${commandPath} rejects documented option ${flag}`).toContain(
          flag,
        );
      }
    },
  );
});

describe(".env.example only carries what the examples read", () => {
  it("documents no variable the examples do not consume", () => {
    const declared = [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    const examples = readSourceTree(join(REPO_ROOT, "examples"));

    for (const variable of declared) {
      const usedByExamples = examples.includes(`process.env.${variable}`);
      const networkVariable = variable.endsWith("_PROXY") || variable === "NODE_EXTRA_CA_CERTS";
      expect(usedByExamples || networkVariable, variable).toBe(true);
    }
  });
});
