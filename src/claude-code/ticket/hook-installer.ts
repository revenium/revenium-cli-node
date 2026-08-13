import { homedir, platform } from "node:os";
import { join, dirname, basename } from "node:path";
import { readFile, writeFile, mkdir, copyFile, chmod, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_BACKUP_RETENTION = 5;
const BACKUP_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const GATE_HOOK_EVENTS = ["UserPromptSubmit", "SessionStart"] as const;

function getInstalledHookPath(): string {
  const pkgRoot = join(__dirname, "..", "..", "..");

  const distPath = join(pkgRoot, "dist", "claude-code", "ticket", "hooks", "ticket-gate.sh");
  const srcPath = join(pkgRoot, "src", "claude-code", "ticket", "hooks", "ticket-gate.sh");
  if (existsSync(distPath)) return distPath;
  return srcPath;
}

function getDeployedHookPath(): string {
  return join(HOME, ".revenium", "hooks", "ticket-gate.sh");
}

export function getManagedSettingsPath(): string {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

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
  allowManagedHooksOnly?: boolean;
  [key: string]: unknown;
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};

    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Unable to read existing settings at ${path}: ${message}. Refusing to overwrite it.`,
      { cause: err },
    ) as NodeJS.ErrnoException;
    wrapped.code = code;
    throw wrapped;
  }

  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid JSON in existing settings at ${path}: ${message}. Refusing to overwrite it.`,
      { cause: err },
    );
  }
}

async function pruneSettingsBackups(path: string, currentBackupName: string): Promise<void> {
  try {
    const directory = dirname(path);
    const prefix = `${basename(path)}.revenium-backup-`;
    const backups = (await readdir(directory))
      .filter((name) => name.startsWith(prefix))
      .filter((name) => BACKUP_TIMESTAMP_PATTERN.test(name.slice(prefix.length)))
      .sort();

    if (backups.length <= SETTINGS_BACKUP_RETENTION) return;

    const retained = backups.slice(-SETTINGS_BACKUP_RETENTION);
    if (backups.includes(currentBackupName) && !retained.includes(currentBackupName)) {
      retained.shift();
      retained.push(currentBackupName);
    }

    const retainedNames = new Set(retained);
    const expired = backups.filter((name) => !retainedNames.has(name));
    await Promise.allSettled(expired.map((name) => unlink(join(directory, name))));
  } catch {}
}

async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let backupName: string | undefined;

  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupName = `${basename(path)}.revenium-backup-${ts}`;
    await copyFile(path, join(dirname(path), backupName));
  }
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  if (backupName) {
    await pruneSettingsBackups(path, backupName);
  }
}

export function injectGateHooks(settings: ClaudeSettings, hookCommand: string): ClaudeSettings {
  let changed = false;
  const hooks: NonNullable<ClaudeSettings["hooks"]> = { ...settings.hooks };

  for (const event of GATE_HOOK_EVENTS) {
    const existing: HookEntry[] = hooks[event] ?? [];
    const alreadyInstalled = existing.some((entry) =>
      entry.hooks?.some((h) => h.command === hookCommand),
    );
    if (!alreadyInstalled) {
      hooks[event] = [...existing, { hooks: [{ type: "command", command: hookCommand }] }];
      changed = true;
    }
  }

  if (!changed) return settings;
  return { ...settings, hooks };
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

async function deployHookScript(): Promise<string> {
  const hookSrc = getInstalledHookPath();
  const hookDest = getDeployedHookPath();

  if (!existsSync(hookSrc)) {
    throw new Error(
      `Hook script not found at ${hookSrc}. Please re-install the @revenium/cli package.`,
    );
  }

  await mkdir(dirname(hookDest), { recursive: true });
  await copyFile(hookSrc, hookDest);
  await chmod(hookDest, 0o755);
  return hookDest;
}

export interface HookInstallResult {
  installed: boolean;
  alreadyInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  message: string;
}

export async function installTicketGateHook(): Promise<HookInstallResult> {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const settings = await readSettings(settingsPath);
  const hookDest = await deployHookScript();
  const updated = injectGateHooks(settings, hookDest);

  const alreadyInstalled = updated === settings;

  if (!alreadyInstalled) {
    await writeSettings(settingsPath, updated);
  }

  return {
    installed: !alreadyInstalled,
    alreadyInstalled,
    settingsPath,
    hookPath: hookDest,
    message: alreadyInstalled
      ? `Ticket gate hook already installed in ${settingsPath}`
      : `Ticket gate hook installed in ${settingsPath} (UserPromptSubmit + SessionStart)`,
  };
}

export async function uninstallTicketGateHook(): Promise<{ removed: boolean; message: string }> {
  const hookDest = getDeployedHookPath();
  const settingsPath = join(CLAUDE_DIR, "settings.json");

  const settings = await readSettings(settingsPath);
  const updated = removeGateHooks(settings, hookDest);

  const removed = updated !== settings;

  if (removed) {
    await writeSettings(settingsPath, updated);
  }

  return {
    removed,
    message: removed
      ? `Ticket gate hook removed from ${settingsPath}`
      : "Ticket gate hook was not installed.",
  };
}

export function buildManagedSettingsTemplate(hookPath: string): ClaudeSettings {
  const entry = (): HookEntry[] => [{ hooks: [{ type: "command", command: hookPath }] }];
  return {
    hooks: {
      UserPromptSubmit: entry(),
      SessionStart: entry(),
    },
    allowManagedHooksOnly: true,
  };
}

export interface ManagedTemplateResult {
  templatePath: string;
  managedPath: string;
  hookPath: string;

  written?: boolean;

  permissionDenied?: boolean;
  message: string;
}

export async function emitManagedSettingsTemplate(
  options: { write?: boolean; outputDir?: string } = {},
): Promise<ManagedTemplateResult> {
  const hookPath = await deployHookScript();
  const managedPath = getManagedSettingsPath();
  const template = buildManagedSettingsTemplate(hookPath);

  const outputDir = options.outputDir ?? process.cwd();
  const templatePath = join(outputDir, "managed-settings-template.json");
  await writeFile(templatePath, JSON.stringify(template, null, 2) + "\n", "utf-8");

  if (!options.write) {
    return {
      templatePath,
      managedPath,
      hookPath,
      message:
        `Template written to ${templatePath}.\n` +
        `Deploy it to ${managedPath} via your MDM / configuration management\n` +
        `(root-owned — this is what makes enforcement real), or re-run with --write.`,
    };
  }

  try {
    const existing = await readSettings(managedPath);
    const withHooks = injectGateHooks(existing, hookPath);
    const merged =
      withHooks.allowManagedHooksOnly === true
        ? withHooks
        : { ...withHooks, allowManagedHooksOnly: true };
    await writeSettings(managedPath, merged);
    return {
      templatePath,
      managedPath,
      hookPath,
      written: true,
      message: `Managed settings written to ${managedPath} (allowManagedHooksOnly=true).`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return {
        templatePath,
        managedPath,
        hookPath,
        written: false,
        permissionDenied: true,
        message:
          `Permission denied writing ${managedPath}.\n` +
          `Try: sudo cp "${templatePath}" "${managedPath}"\n` +
          `(managed settings must be root/MDM-owned to be enforceable).`,
      };
    }
    throw err;
  }
}
