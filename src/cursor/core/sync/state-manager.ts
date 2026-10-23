import { join } from "node:path";
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { STATE_FILE, DIR_MODE } from "../../constants.js";
import { parseSentRecords } from "../../../_core/sync/sent-record-log.js";
import { CONFIG_FILE_MODE } from "../../../_core/constants.js";
import { getConfigDir } from "../../config/loader.js";
import type { SyncState } from "../../types.js";

function getStatePath(): string {
  return join(getConfigDir(), STATE_FILE);
}

function createDefaultState(): SyncState {
  return {
    lastSyncTimestamp: 0,
    lastSyncEventCount: 0,
    totalEventsSynced: 0,
    sentRecords: {},
  };
}

export async function loadState(): Promise<SyncState> {
  const statePath = getStatePath();

  if (!existsSync(statePath)) {
    return createDefaultState();
  }

  try {
    const content = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(content) as SyncState;

    if (typeof parsed.lastSyncTimestamp !== "number") {
      return createDefaultState();
    }

    return {
      lastSyncTimestamp: parsed.lastSyncTimestamp,
      lastSyncEventCount: parsed.lastSyncEventCount || 0,
      totalEventsSynced: parsed.totalEventsSynced || 0,
      sentRecords: parseSentRecords(parsed.sentRecords),
    };
  } catch {
    return createDefaultState();
  }
}

export async function saveState(state: SyncState): Promise<void> {
  const configDir = getConfigDir();
  const statePath = getStatePath();
  const tmpPath = join(configDir, `state-${randomBytes(4).toString("hex")}.tmp`);

  await mkdir(configDir, { recursive: true, mode: DIR_MODE });

  await writeFile(tmpPath, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
  });

  await rename(tmpPath, statePath);

  try {
    await chmod(statePath, CONFIG_FILE_MODE);
  } catch {
    // ignore permission errors on some platforms
  }
}

export async function resetState(): Promise<void> {
  await saveState(createDefaultState());
}
