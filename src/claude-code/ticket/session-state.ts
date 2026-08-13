import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface SessionTicketState {
  ticketId: string;
  ticketTitle?: string;
  reason?: string;
  associatedAt: string;
  sessionId: string;

  postedTicketId?: string;

  cwd?: string;
}

export interface RepoTicketState {
  ticketId: string;
  ticketTitle?: string;
  reason?: string;
  associatedAt: string;
}

function stateDir(): string {
  return join(homedir(), ".revenium", "ticket-state");
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sessionStateFile(sessionId: string): string {
  const safe = sanitizeForFilename(sessionId);
  return join(stateDir(), `session-${safe}.json`);
}

function associationPendingFile(sessionId: string, ticketId: string): string {
  const safeSession = sanitizeForFilename(sessionId);
  const safeTicket = sanitizeForFilename(ticketId);
  return join(stateDir(), `association-pending-${safeSession}-${safeTicket}.txt`);
}

function cwdKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

function repoStateFile(cwd: string): string {
  return join(stateDir(), `repo-${cwdKey(cwd)}.json`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

export async function getActiveTicket(
  sessionId: string,
  cwd: string,
): Promise<SessionTicketState | null> {
  const bySession = await readJson<SessionTicketState>(sessionStateFile(sessionId));
  if (bySession) return bySession;

  const byRepo = await readJson<RepoTicketState>(repoStateFile(cwd));
  if (byRepo) {
    return {
      ticketId: byRepo.ticketId,
      ticketTitle: byRepo.ticketTitle,
      reason: byRepo.reason,
      associatedAt: byRepo.associatedAt,
      sessionId,
    };
  }

  return null;
}

export async function setActiveTicket(
  sessionId: string,
  cwd: string,
  ticketId: string,
  ticketTitle?: string,
  postedTicketId?: string,
  reason?: string,
): Promise<void> {
  const now = new Date().toISOString();

  const sessionState: SessionTicketState = {
    ticketId,
    ticketTitle,
    reason,
    associatedAt: now,
    sessionId,
    postedTicketId,
    cwd,
  };

  const repoState: RepoTicketState = {
    ticketId,
    ticketTitle,
    reason,
    associatedAt: now,
  };

  await Promise.all([
    writeJson(sessionStateFile(sessionId), sessionState),
    writeJson(repoStateFile(cwd), repoState),
  ]);
}

export async function markAssociationPending(sessionId: string, ticketId: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(
    associationPendingFile(sessionId, ticketId),
    String(Math.floor(Date.now() / 1000)),
    "utf-8",
  );
}

export async function clearAssociationPending(sessionId: string, ticketId: string): Promise<void> {
  try {
    await unlink(associationPendingFile(sessionId, ticketId));
  } catch {}
}

export async function isAssociationPending(sessionId: string, ticketId: string): Promise<boolean> {
  return existsSync(associationPendingFile(sessionId, ticketId));
}

export async function setRepoTicket(
  cwd: string,
  ticketId: string,
  ticketTitle?: string,
  reason?: string,
): Promise<void> {
  const repoState: RepoTicketState = {
    ticketId,
    ticketTitle,
    reason,
    associatedAt: new Date().toISOString(),
  };
  await writeJson(repoStateFile(cwd), repoState);
}

export async function getRepoTicket(cwd: string): Promise<RepoTicketState | null> {
  return readJson<RepoTicketState>(repoStateFile(cwd));
}

export const SESSION_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function listSessionStatesForCwd(
  cwd: string,
  maxAgeMs: number = SESSION_LIVE_WINDOW_MS,
): Promise<SessionTicketState[]> {
  const dir = stateDir();
  if (!existsSync(dir)) return [];

  const cutoff = Date.now() - maxAgeMs;
  const results: SessionTicketState[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  for (const f of files) {
    if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
    const full = join(dir, f);
    try {
      const s = await stat(full);
      if (s.mtimeMs < cutoff) continue;
      const state = await readJson<SessionTicketState>(full);
      if (state && state.cwd === cwd) results.push(state);
    } catch {}
  }
  return results;
}

export async function pruneStaleState(maxAgeDays = 30): Promise<number> {
  let pruned = 0;
  try {
    const dir = stateDir();
    if (!existsSync(dir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".json") && !f.endsWith(".txt")) continue;
      const full = join(dir, f);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await unlink(full);
          pruned++;
        }
      } catch {}
    }
  } catch {}
  return pruned;
}
