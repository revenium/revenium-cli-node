import chalk from "chalk";
import { spawnSync, execSync } from "node:child_process";
import {
  isValidTicketId,
  buildTicketOtelAttrs,
  mergeOtelAttrs,
  buildTraceName,
  MAX_TICKET_ID_LENGTH,
  TICKET_NONE,
} from "../ticket/ticket-utils.js";
import { resolveLinearTitle } from "../ticket/linear-resolver.js";
import { postAssociation, sanitizeRepoUrl } from "../ticket/association-client.js";
import {
  setActiveTicket,
  setRepoTicket,
  getRepoTicket,
  getActiveTicket,
  listSessionStatesForCwd,
  pruneStaleState,
  markAssociationPending,
  clearAssociationPending,
} from "../ticket/session-state.js";
import { loadConfig } from "../config/loader.js";

export interface TicketLaunchOptions {
  ticketId: string;

  title?: string;

  claudeArgs?: string[];

  cwd?: string;
}

export interface TicketSwitchOptions {
  ticketId: string;
  ticketTitle?: string;
  reason?: string;

  sessionId?: string;

  cwd?: string;
}

export interface TicketGateAssociateOptions {
  sessionId: string;
  ticketId: string;
  ticketTitle?: string;
  reason?: string;
  cwd?: string;
}

export async function ticketLaunchCommand(options: TicketLaunchOptions): Promise<void> {
  const { ticketId: rawId, claudeArgs = [] } = options;

  if (!isValidTicketId(rawId)) {
    console.error(chalk.red(`Error: '${rawId}' is not a valid ticket ID.`));
    console.error(chalk.dim("Expected format: PROJECT-123 (e.g. PRODUCT-1234, BACK-42)"));
    process.exit(1);
  }

  const ticketId = rawId === TICKET_NONE ? TICKET_NONE : rawId.toUpperCase();

  if (ticketId === TICKET_NONE) {
    console.error(
      chalk.red("Error: `ticket launch none` cannot record the required opt-out reason."),
    );
    console.error(
      chalk.dim("Start Claude Code normally, then type: switch-ticket none --reason <reason>"),
    );
    process.exit(1);
  }

  let title: string | undefined = options.title;
  if (!title && ticketId !== TICKET_NONE) {
    process.stderr.write(chalk.dim(`Resolving ticket title for ${ticketId}...\n`));
    title = await resolveLinearTitle(ticketId);
  }

  const traceName = buildTraceName(ticketId, title);
  console.error(chalk.cyan(`revenium: metering session against ${traceName}`));

  const ticketAttrs = buildTicketOtelAttrs(ticketId, title);
  const merged = mergeOtelAttrs(process.env.OTEL_RESOURCE_ATTRIBUTES, ticketAttrs);

  const cwd = options.cwd ?? process.cwd();
  try {
    await setRepoTicket(cwd, ticketId, title);
  } catch {}

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OTEL_RESOURCE_ATTRIBUTES: merged,
    REVENIUM_TICKET: ticketId,
    REVENIUM_TICKET_TITLE: title ?? "",
  };

  const result = spawnSync("claude", claudeArgs, {
    env,
    stdio: "inherit",
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(chalk.red("Error: 'claude' not found in PATH."));
      console.error(chalk.dim("Install Claude Code: npm install -g @anthropic-ai/claude-code"));
    } else {
      console.error(chalk.red(`Error launching claude: ${result.error.message}`));
    }
    process.exit(1);
  }

  process.exit(result.status ?? (result.signal ? 1 : 0));
}

export async function ticketSwitchCommand(options: TicketSwitchOptions): Promise<void> {
  const { ticketId: rawId, reason } = options;

  if (!isValidTicketId(rawId)) {
    console.error(chalk.red(`Error: '${rawId}' is not a valid ticket ID.`));
    console.error(chalk.dim("Expected format: PROJECT-123 or 'none' (opt-out)"));
    process.exit(1);
  }

  const ticketId = rawId === TICKET_NONE ? TICKET_NONE : rawId.toUpperCase();

  if (ticketId === TICKET_NONE && !reason?.trim()) {
    console.error(chalk.red("Error: explicit opt-out requires --reason <reason>."));
    process.exit(1);
  }

  let title: string | undefined = options.ticketTitle;
  if (!title && ticketId !== TICKET_NONE) {
    title = await resolveLinearTitle(ticketId);
  }

  const traceName = buildTraceName(ticketId, title);
  const cwd = options.cwd ?? process.cwd();

  let sessionId = options.sessionId;
  let ambiguous = false;
  if (!sessionId) {
    const candidates = await listSessionStatesForCwd(cwd);
    if (candidates.length === 1) {
      sessionId = candidates[0].sessionId;
    } else if (candidates.length > 1) {
      ambiguous = true;
    }
  }

  if (!sessionId) {
    await setRepoTicket(cwd, ticketId, title, reason?.trim());
    if (ambiguous) {
      console.log(
        chalk.yellow(
          `Multiple active Claude Code sessions share this directory — refusing to guess which one to switch.`,
        ),
      );
      console.log(
        chalk.dim(
          "Switch from inside the target session by typing `switch-ticket " +
            ticketId +
            "` as your next prompt, or re-run with --session-id <id> " +
            "(check `revenium-metering ticket status` in each terminal).",
        ),
      );
    } else {
      console.log(chalk.green(`Ticket set to ${chalk.bold(traceName)} for this repo.`));
      console.log(
        chalk.dim(
          "No active session id known yet — attribution engages on your next prompt " +
            "(the gate hook associates the session automatically).",
        ),
      );
    }
    return;
  }

  await setActiveTicket(sessionId, cwd, ticketId, title, ticketId, reason);
  await markAssociationPending(sessionId, ticketId);

  const config = await loadConfig();

  if (!config) {
    console.log(chalk.yellow("Warning: No Revenium configuration found."));
    console.log(chalk.dim("Run `revenium-metering setup` first."));
    return;
  }

  const result = await postAssociation(config.endpoint, config.apiKey, {
    sessionId,
    ticketId,
    ticketTitle: title,
    reason,
    source: "claude-code",
    subscriberEmail: config.email,
    repo: getGitRemote(cwd),
    branch: getGitBranch(cwd),
    teamId: config.teamId,
  });

  if (result.degraded) {
    if (!result.retryable) {
      await clearAssociationPending(sessionId, ticketId);
    }
    console.log(chalk.yellow(`[Revenium] ${result.reason}`));
    console.log(
      chalk.dim(
        "The local ticket state was updated, but the server did not confirm the switch. " +
          (result.retryable
            ? "The gate will retry on the next prompt. "
            : "Correct the configuration and switch again to retry. ") +
          "To guarantee launch-time attribution now, relaunch with:\n" +
          chalk.cyan(`  revenium-metering ticket launch ${ticketId}`),
      ),
    );
  } else {
    await clearAssociationPending(sessionId, ticketId);
    console.log(chalk.green(`Ticket switched to ${chalk.bold(traceName)}`));
    if (ticketId === TICKET_NONE) {
      console.log(chalk.dim("This session will be tracked as explicitly unattributed."));
    }
  }
}

export async function ticketGateAssociateCommand(
  options: TicketGateAssociateOptions,
): Promise<void> {
  try {
    const rawTicketId = options.ticketId;
    if (!isValidTicketId(rawTicketId)) return;
    const ticketId = rawTicketId.slice(0, MAX_TICKET_ID_LENGTH);

    await pruneStaleState(30);

    const config = await loadConfig();
    if (!config) return;

    const cwd = options.cwd ?? process.cwd();

    const ticketTitle =
      options.ticketTitle ??
      (ticketId === TICKET_NONE ? undefined : await resolveLinearTitle(ticketId));

    const result = await postAssociation(config.endpoint, config.apiKey, {
      sessionId: options.sessionId,
      ticketId,
      ticketTitle,
      reason: options.reason,
      source: "claude-code",
      subscriberEmail: config.email,
      repo: getGitRemote(cwd),
      branch: getGitBranch(cwd),
      teamId: config.teamId,
    });
    if (!result.degraded || !result.retryable) {
      await clearAssociationPending(options.sessionId, ticketId);
    }
  } catch {}
}

export async function ticketStatusCommand(sessionId?: string, cwd?: string): Promise<void> {
  const effectiveCwd = cwd ?? process.cwd();

  const envTicket = process.env.REVENIUM_TICKET;
  if (envTicket) {
    const envTitle = process.env.REVENIUM_TICKET_TITLE;
    console.log(
      chalk.bold("Active ticket (env):"),
      chalk.cyan(buildTraceName(envTicket, envTitle)),
    );
    return;
  }

  const state = sessionId
    ? await getActiveTicket(sessionId, effectiveCwd)
    : await getRepoTicket(effectiveCwd);

  if (state) {
    const traceName = buildTraceName(state.ticketId, state.ticketTitle);
    console.log(chalk.bold("Active ticket (state):"), chalk.cyan(traceName));
    console.log(chalk.dim(`Associated at: ${state.associatedAt}`));
  } else {
    console.log(chalk.yellow("No ticket attribution active for this session."));
    console.log(chalk.dim(`Run: revenium-metering ticket launch <TICKET-ID>`));
  }
}

function getGitBranch(cwd: string): string | undefined {
  const run = (command: string): string | undefined => {
    try {
      return (
        execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim() ||
        undefined
      );
    } catch {
      return undefined;
    }
  };
  return run("git branch --show-current") ?? run("git symbolic-ref --short HEAD");
}

function getGitRemote(cwd: string): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return sanitizeRepoUrl(remote) || undefined;
  } catch {
    return undefined;
  }
}
