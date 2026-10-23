import { loadConfig, getConfigPath, getFishConfigPath } from "../config/loader.js";
import { renameLegacyKeyNameInFile } from "../config/legacy-rename.js";
import { printLegacyKeyNameRewritten, printLegacyKeyNameRewriteFailed } from "./legacy-notice.js";
import type { CursorConfig } from "../types.js";

interface RenameOutcome {
  path: string;
  renamed: boolean;
  failed: boolean;
}

async function tryRenameLegacyKeyName(path: string): Promise<RenameOutcome> {
  try {
    return { path, renamed: await renameLegacyKeyNameInFile(path), failed: false };
  } catch {
    return { path, renamed: false, failed: true };
  }
}

function pathsWhere(
  outcomes: readonly RenameOutcome[],
  matches: (outcome: RenameOutcome) => boolean,
): string[] {
  return outcomes.filter(matches).map((outcome) => outcome.path);
}

export async function loadMigratedConfig(): Promise<CursorConfig | null> {
  const config = await loadConfig();

  if (!config) {
    return null;
  }

  const outcomes = await Promise.all(
    [getConfigPath(), getFishConfigPath()].map(tryRenameLegacyKeyName),
  );

  const failedPaths = pathsWhere(outcomes, (outcome) => outcome.failed);
  const renamedPaths = pathsWhere(outcomes, (outcome) => outcome.renamed);

  if (renamedPaths.length > 0) {
    printLegacyKeyNameRewritten(renamedPaths);
  }
  if (failedPaths.length > 0) {
    printLegacyKeyNameRewriteFailed(failedPaths);
  }

  return config;
}
