import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const HOSTILE_SHELL_VALUES = [
  "Acme Corp",
  "R&D",
  "Build$(touch $TMPDIR/substitution-ran)",
  "Build`touch $TMPDIR/backtick-ran`",
  "it's",
  'say "hi"',
  "back\\slash",
  "a\\'b",
  "a;b && c",
  "*",
  "$HOME",
  "'",
  "''",
  "first\r\nsecond",
];

function isAvailable(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const POSIX_SHELLS = ["/bin/bash", "/bin/zsh"].filter(isAvailable);

export const FISH_AVAILABLE = isAvailable("fish");

export interface ShellReadResult {
  stdout: string;
  stderr: string;
}

export async function readExportedVar(
  shell: string,
  sourceCommand: string,
  name: string,
): Promise<ShellReadResult> {
  const { stdout, stderr } = await run(shell, ["-c", `${sourceCommand}; printenv ${name}`]);
  return { stdout: stdout.replace(/\n$/, ""), stderr };
}

export async function readExportedVarFromPosixShell(
  shell: string,
  envPath: string,
  name: string,
): Promise<ShellReadResult> {
  return readExportedVar(shell, `. "${envPath}"`, name);
}
