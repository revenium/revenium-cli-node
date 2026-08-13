#!/usr/bin/env node

import { Command, Option } from "commander";
import { setupCommand, type SetupOptions } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { testCommand } from "../commands/test.js";
import { backfillCommand } from "../commands/backfill.js";
import {
  ticketLaunchCommand,
  ticketSwitchCommand,
  ticketStatusCommand,
  ticketGateAssociateCommand,
} from "../commands/ticket.js";
import {
  installTicketGateHook,
  uninstallTicketGateHook,
  emitManagedSettingsTemplate,
} from "../ticket/hook-installer.js";
import pkg from "../../../package.json";

export const program = new Command();

interface CliSetupOptions {
  apiKey?: string;
  email?: string;
  tier?: string;
  endpoint?: string;
  organization?: string;
  product?: string;
  teamId?: string;
  ticketIdRegex?: string;
  ticketBlockPolicy?: string;
  skipShellUpdate?: boolean;
  extraUsageEnabled?: boolean;
  installTicketGate?: boolean;
  skipTicketGate?: boolean;
}

export function toSetupOptions(options: CliSetupOptions): SetupOptions {
  return {
    apiKey: options.apiKey,
    email: options.email,
    tier: options.tier,
    endpoint: options.endpoint,
    organizationName: options.organization,
    productName: options.product,
    teamId: options.teamId,
    ticketIdRegex: options.ticketIdRegex,
    blockPolicy: options.ticketBlockPolicy,
    skipShellUpdate: options.skipShellUpdate,
    extraUsageEnabled: options.extraUsageEnabled || undefined,
    installTicketGate: options.installTicketGate,
    skipTicketGate: options.skipTicketGate,
  };
}

export function splitTicketLaunchArguments(
  titleWords: string[],
  rawArgs: string[],
): { title?: string; claudeArgs: string[] } {
  const separatorIndex = rawArgs.indexOf("--");
  const claudeArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);
  const titleWordCount =
    separatorIndex === -1 ? titleWords.length : Math.max(0, titleWords.length - claudeArgs.length);
  const titleParts = titleWords.slice(0, titleWordCount);

  return {
    title: titleParts.length > 0 ? titleParts.join(" ") : undefined,
    claudeArgs,
  };
}

program
  .name("revenium-metering")
  .description("Configure Claude Code telemetry export to Revenium")
  .version(pkg.version);

program
  .command("setup")
  .description("Interactive setup wizard to configure Claude Code metering")
  .option("-k, --api-key <key>", "Revenium API key (hak_... or rev_...)")
  .option("-e, --email <email>", "Email for usage attribution")
  .option("-t, --tier <tier>", "Subscription tier")
  .option("--endpoint <url>", "Revenium API endpoint URL")
  .option("-o, --organization <name>", "Organization name for cost attribution")
  .option("-p, --product <name>", "Product name for cost attribution")
  .option(
    "--team-id <id>",
    "Organization hashid for session attribution (optional when the backend derives it from the metering key)",
  )
  .option("--ticket-id-regex <regex>", "Organization ticket ID regex for the gate")
  .option(
    "--ticket-block-policy <policy>",
    "Ticket gate policy: remind-only (default), hard-block, or a free-prompt count",
  )
  .option("--skip-shell-update", "Skip automatic shell profile update")
  .option("--extra-usage-enabled", "Set CLAUDE_CODE_EXTRA_USAGE_ENABLED=1 in SDK config")
  .addOption(
    new Option(
      "--install-ticket-gate",
      "Install the ticket gate without prompting (for scripted setup)",
    ).conflicts("skipTicketGate"),
  )
  .addOption(
    new Option(
      "--skip-ticket-gate",
      "Do not install or prompt for the ticket gate (for scripted setup)",
    ).conflicts("installTicketGate"),
  )
  .action(async (options: CliSetupOptions) => {
    await setupCommand(toSetupOptions(options));
  });

program
  .command("status")
  .description("Check current configuration and endpoint connectivity")
  .action(async () => {
    await statusCommand();
  });

program
  .command("test")
  .description("Send a test metric to verify the integration")
  .option("-v, --verbose", "Show detailed payload information")
  .action(async (options) => {
    await testCommand({ verbose: options.verbose });
  });

program
  .command("backfill")
  .description("Import historical Claude Code usage data from local JSONL files")
  .option(
    "--since <date>",
    'Only backfill after this date (ISO format or relative like "7d", "1m")',
  )
  .option("--dry-run", "Show what would be sent without sending")
  .option("--batch-size <n>", "Messages per API batch, max 100 (default: 10)", "10")
  .option("--delay <ms>", "Minimum delay between batches in milliseconds (default: 0)", "0")
  .option("-v, --verbose", "Show detailed progress")
  .option(
    "--email <email>",
    "Email to attribute backfilled usage to (overrides the configured email; prompted if neither is set)",
  )
  .action(async (options) => {
    const batchSize = parseInt(options.batchSize, 10);
    if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 100) {
      console.error("Error: --batch-size must be between 1 and 100");
      process.exit(1);
    }

    const delay = parseInt(options.delay, 10);
    if (!Number.isFinite(delay) || delay < 0 || delay > 60000) {
      console.error("Error: --delay must be between 0 and 60000 milliseconds");
      process.exit(1);
    }

    await backfillCommand({
      since: options.since,
      dryRun: options.dryRun,
      batchSize,
      delay,
      verbose: options.verbose,
      email: options.email,
    });
  });

const ticket = program
  .command("ticket")
  .description("Ticket attribution: launch Claude Code against a ticket, or switch mid-session");

ticket
  .command("launch <ticketId> [title...]")
  .description(
    "Launch Claude Code with ticket attribution injected and wait for it to exit. " +
      "An optional title must appear before --. Pass Claude arguments after --, e.g.: " +
      "revenium-metering ticket launch PRODUCT-1234 'Fix login' -- -p 'prompt'",
  )
  .allowUnknownOption()
  .action(async (ticketId: string, titleWords: string[], _opts: unknown, _cmd: Command) => {
    const { title, claudeArgs } = splitTicketLaunchArguments(titleWords, process.argv);
    await ticketLaunchCommand({ ticketId, title, claudeArgs });
  });

ticket
  .command("switch <ticketId>")
  .description(
    "Switch ticket attribution for an explicit or uniquely resolved live Claude Code session",
  )
  .option("-t, --title <title>", "Ticket title (skips Linear lookup)")
  .option("-r, --reason <reason>", "Reason for switch (stored in attribution record)")
  .option(
    "--session-id <id>",
    "Explicit Claude Code session ID (otherwise requires exactly one live session in this repo)",
  )
  .action(
    async (ticketId: string, opts: { title?: string; reason?: string; sessionId?: string }) => {
      await ticketSwitchCommand({
        ticketId,
        ticketTitle: opts.title,
        reason: opts.reason,
        sessionId: opts.sessionId,
      });
    },
  );

ticket
  .command("status")
  .description("Show the active ticket attribution for the current session / repo")
  .option("--session-id <id>", "Explicit Claude Code session ID")
  .action(async (opts: { sessionId?: string }) => {
    await ticketStatusCommand(opts.sessionId);
  });

const ticketGate = program
  .command("ticket-gate")
  .description("Manage the Revenium ticket gate hook for Claude Code");

ticketGate
  .command("install")
  .description("Install the ticket gate hook into ~/.claude/settings.json (user-global)")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    try {
      const result = await installTicketGateHook();
      if (result.alreadyInstalled) {
        console.log(chalk.yellow(result.message));
      } else {
        console.log(chalk.green(result.message));
        console.log(chalk.dim(`Hook deployed to: ${result.hookPath}`));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : "unknown error"}`));
      process.exit(1);
    }
  });

ticketGate
  .command("uninstall")
  .description("Remove the ticket gate hook from ~/.claude/settings.json")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    try {
      const result = await uninstallTicketGateHook();
      console.log(result.removed ? chalk.green(result.message) : chalk.yellow(result.message));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : "unknown error"}`));
      process.exit(1);
    }
  });

ticketGate
  .command("install-managed")
  .description(
    "Emit a managed-settings template (hook entries + allowManagedHooksOnly:true) for " +
      "org-wide enforcement. Managed settings live at the OS level (macOS: " +
      "/Library/Application Support/ClaudeCode/managed-settings.json) — deploy via MDM. " +
      "Use --write to attempt a direct write (usually needs sudo). " +
      "See docs/ticket-gate-org-rollout.md.",
  )
  .option("--write", "Attempt to write the OS-level managed-settings path directly")
  .action(async (opts: { write?: boolean }) => {
    const chalk = (await import("chalk")).default;
    try {
      const result = await emitManagedSettingsTemplate({ write: opts.write });
      if (result.permissionDenied) {
        console.log(chalk.yellow(result.message));
      } else {
        console.log(chalk.green(result.message));
      }
      console.log(chalk.dim(`Hook deployed to: ${result.hookPath}`));
      console.log(chalk.dim(`Managed settings target: ${result.managedPath}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : "unknown error"}`));
      process.exit(1);
    }
  });

ticketGate
  .command("associate", { hidden: true })
  .requiredOption("--session-id <id>", "Claude Code session ID (from hook stdin JSON)")
  .requiredOption("--ticket <ticketId>", "Ticket ID to attribute the session to")
  .option("--title <title>", "Ticket title")
  .option("--reason <reason>", "Reason for the switch or explicit opt-out")
  .option("--cwd <dir>", "Working directory (for repo/branch context)")
  .action(
    async (opts: {
      sessionId: string;
      ticket: string;
      title?: string;
      reason?: string;
      cwd?: string;
    }) => {
      await ticketGateAssociateCommand({
        sessionId: opts.sessionId,
        ticketId: opts.ticket,
        ticketTitle: opts.title,
        reason: opts.reason,
        cwd: opts.cwd,
      });
    },
  );

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
