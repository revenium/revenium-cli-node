import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const GATE_HOOK_EVENTS = ["UserPromptSubmit", "SessionStart"] as const;

interface HookDefinition {
  type: "command";
  command: string;
}

interface HookEntry {
  hooks: HookDefinition[];
}

interface ClaudeSettings {
  hooks?: {
    [key: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

export interface LegacyTicketGateCleanupOptions {
  settingsPath?: string;
  hookPath?: string;
}

export interface LegacyTicketGateCleanupResult {
  hookRemovedFromSettings: boolean;
  scriptDeleted: boolean;
}

function getDefaultHookPath(): string {
  return join(homedir(), ".revenium", "hooks", "ticket-gate.sh");
}

function getDefaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function removeGateHooks(settings: ClaudeSettings, hookCommand: string): ClaudeSettings {
  if (!settings.hooks) return settings;

  let changed = false;
  const hooks: NonNullable<ClaudeSettings["hooks"]> = { ...settings.hooks };

  for (const event of GATE_HOOK_EVENTS) {
    const existing = hooks[event];
    if (!existing) continue;
    const filtered: HookEntry[] = [];
    let eventChanged = false;

    for (const entry of existing) {
      if (!Array.isArray(entry.hooks)) {
        filtered.push(entry);
        continue;
      }

      const remainingHooks = entry.hooks.filter((hook) => hook.command !== hookCommand);
      if (remainingHooks.length === entry.hooks.length) {
        filtered.push(entry);
        continue;
      }

      eventChanged = true;
      if (remainingHooks.length > 0) {
        filtered.push({ ...entry, hooks: remainingHooks });
      }
    }

    if (eventChanged) {
      hooks[event] = filtered;
      changed = true;
    }
  }

  if (!changed) return settings;
  return { ...settings, hooks };
}

export async function removeLegacyTicketGate(
  options: LegacyTicketGateCleanupOptions = {},
): Promise<LegacyTicketGateCleanupResult> {
  const hookPath = options.hookPath ?? getDefaultHookPath();
  const settingsPath = options.settingsPath ?? getDefaultSettingsPath();

  let hookRemovedFromSettings = false;
  let scriptDeleted = false;

  try {
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as ClaudeSettings;
    const updated = removeGateHooks(settings, hookPath);

    if (updated !== settings) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupName = `${basename(settingsPath)}.revenium-backup-${ts}`;
      await copyFile(settingsPath, join(dirname(settingsPath), backupName));
      await writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
      hookRemovedFromSettings = true;
    }
  } catch {
    hookRemovedFromSettings = false;
  }

  if (existsSync(hookPath)) {
    try {
      await rm(hookPath, { force: true });
      scriptDeleted = true;
    } catch {
      scriptDeleted = false;
    }
  }

  return { hookRemovedFromSettings, scriptDeleted };
}
