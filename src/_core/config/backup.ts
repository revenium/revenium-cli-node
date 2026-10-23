import { basename, dirname, join } from "node:path";
import { chmod, copyFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

const BACKUP_RETENTION = 5;
const BACKUP_INFIX = ".revenium-backup-";
const BACKUP_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

async function pruneBackups(path: string, currentBackupName: string): Promise<void> {
  try {
    const directory = dirname(path);
    const prefix = `${basename(path)}${BACKUP_INFIX}`;
    const backups = (await readdir(directory))
      .filter((name) => name.startsWith(prefix))
      .filter((name) => BACKUP_TIMESTAMP_PATTERN.test(name.slice(prefix.length)))
      .sort();

    const others = backups.filter((name) => name !== currentBackupName);
    const retained = new Set(others.slice(-(BACKUP_RETENTION - 1)));
    retained.add(currentBackupName);

    const expired = backups.filter((name) => !retained.has(name));
    await Promise.allSettled(expired.map((name) => unlink(join(directory, name))));
  } catch {}
}

export async function backupConfigFile(path: string, mode?: number): Promise<string | null> {
  if (!existsSync(path)) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${basename(path)}${BACKUP_INFIX}${timestamp}`;
  const backupPath = join(dirname(path), backupName);

  await copyFile(path, backupPath);
  await chmod(backupPath, mode ?? (await stat(path)).mode & 0o777);
  await pruneBackups(path, backupName);

  return backupPath;
}
