import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ENV_KEYS, LEGACY_CURSOR_API_KEY } from "../constants.js";

const ASSIGNMENT = /^\s*(?:export\s+|set\s+-gx\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[= ]/;

function assignedKey(line: string): string | undefined {
  return ASSIGNMENT.exec(line)?.[1];
}

export function renameLegacyKeyName(content: string): string | null {
  const lines = content.split("\n");

  if (!lines.some((line) => assignedKey(line) === LEGACY_CURSOR_API_KEY)) {
    return null;
  }

  const alreadyMigrated = lines.some(
    (line) => assignedKey(line) === ENV_KEYS.REVENIUM_CURSOR_API_KEY,
  );
  const rewritten = alreadyMigrated
    ? lines.filter((line) => assignedKey(line) !== LEGACY_CURSOR_API_KEY)
    : lines.map((line) =>
        assignedKey(line) === LEGACY_CURSOR_API_KEY
          ? line.replace(LEGACY_CURSOR_API_KEY, ENV_KEYS.REVENIUM_CURSOR_API_KEY)
          : line,
      );

  return rewritten.join("\n");
}

export async function renameLegacyKeyNameInFile(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    return false;
  }

  const rewritten = renameLegacyKeyName(await readFile(path, "utf-8"));
  if (rewritten === null) {
    return false;
  }

  await writeFile(path, rewritten, "utf-8");
  return true;
}
