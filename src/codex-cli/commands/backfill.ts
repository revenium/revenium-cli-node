import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import ora from "ora";
import { extractOtelValues, readCodexToml } from "../config/loader.js";
import { CODEX_CONFIG_DIR } from "../constants.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { startupStagger } from "../../_core/api/resilience.js";
import { parseEnvContent, parseOtelResourceAttributes } from "../../_core/config/loader.js";
import { REVENIUM_API_KEY_ATTR, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import type { OTLPLogsPayload } from "../../_core/types/index.js";

const DEFAULT_SESSIONS_PATH = join(homedir(), ".codex", "sessions");
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 1000;
const CODEX_EXEC_SERVICE_NAME = "codex_exec";
const CODEX_TUI_SERVICE_NAME = "codex_cli_rs";

type StringAttribute = { key: string; value: { stringValue: string } };

export interface BackfillOptions {
  since?: string;
  to?: string;
  dryRun?: boolean;
  batchSize?: number;
  verbose?: boolean;
  sessionsPath?: string;
  configPath?: string;
}

export interface ParsedCodexEvent {
  sessionId: string;
  serviceName: string;
  resolvedTimestampNanos: string;
  model: string;
  inputs: number;
  outputs: number;
  cached: number;
  reasoning: number;
  toolTokens: number;
  dedupeKey?: string;
}

function parseRelativeDate(input: string): Date | null {
  const match = input.match(/^(\d+)([dmwMy])$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case "d":
      now.setDate(now.getDate() - amount);
      break;
    case "w":
      now.setDate(now.getDate() - amount * 7);
      break;
    case "m":
    case "M":
      now.setMonth(now.getMonth() - amount);
      break;
    case "y":
      now.setFullYear(now.getFullYear() - amount);
      break;
    default:
      return null;
  }
  return now;
}

export function parseDateInput(input?: string): Date | null {
  if (!input) return null;
  return (
    parseRelativeDate(input) ?? (Number.isNaN(new Date(input).getTime()) ? null : new Date(input))
  );
}

function toUnixNanos(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? (BigInt(Math.trunc(value)) * BigInt(1_000_000)).toString()
      : null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return (BigInt(parsed.getTime()) * BigInt(1_000_000)).toString();
}

function buildTurnDedupeKey(
  serviceName: string,
  sessionId: string,
  model: string,
  turnId: string,
): string {
  return ["codex-turn", serviceName, sessionId, model, turnId].join("|");
}

export function hashTransactionId(event: ParsedCodexEvent): string {
  const input = [
    event.sessionId,
    event.resolvedTimestampNanos,
    event.model,
    event.inputs,
    event.outputs,
    event.cached,
    event.reasoning,
    event.toolTokens,
  ].join("|");
  return createHash("sha256").update(input).digest("hex").substring(0, 32);
}

export function deduplicateCodexEvents(events: ParsedCodexEvent[]): {
  events: ParsedCodexEvent[];
  duplicateCount: number;
} {
  const deduped = new Map<string, ParsedCodexEvent>();
  const passthrough: ParsedCodexEvent[] = [];
  let duplicateCount = 0;

  for (const event of events) {
    if (!event.dedupeKey) {
      passthrough.push(event);
      continue;
    }

    const existing = deduped.get(event.dedupeKey);
    if (!existing) {
      deduped.set(event.dedupeKey, event);
      continue;
    }

    duplicateCount++;
    deduped.set(event.dedupeKey, {
      ...existing,
      inputs: Math.max(existing.inputs, event.inputs),
      outputs: Math.max(existing.outputs, event.outputs),
      cached: Math.max(existing.cached, event.cached),
      reasoning: Math.max(existing.reasoning, event.reasoning),
      toolTokens: Math.max(existing.toolTokens, event.toolTokens),
      resolvedTimestampNanos:
        BigInt(event.resolvedTimestampNanos) >= BigInt(existing.resolvedTimestampNanos)
          ? event.resolvedTimestampNanos
          : existing.resolvedTimestampNanos,
    });
  }

  return { events: [...passthrough, ...deduped.values()], duplicateCount };
}

async function findRolloutFiles(root: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await findRolloutFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout") && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
  return out;
}

export interface RolloutContext {
  sessionId: string;
  model: string;
  serviceName: string;
  turnId?: string;
}

function resolveServiceName(originator?: string): string {
  return originator === CODEX_TUI_SERVICE_NAME || originator === "codex-tui"
    ? CODEX_TUI_SERVICE_NAME
    : CODEX_EXEC_SERVICE_NAME;
}

export function parseSessionMeta(line: string): { sessionId: string; serviceName: string } | null {
  const parsed = JSON.parse(line) as {
    type?: string;
    payload?: { id?: string; originator?: string };
  };
  if (parsed.type !== "session_meta") return null;
  const sessionId = parsed.payload?.id;
  if (!sessionId) return null;
  return { sessionId, serviceName: resolveServiceName(parsed.payload?.originator) };
}

export function parseTurnContextModel(line: string): string | null {
  return parseTurnContext(line)?.model ?? null;
}

export function parseTurnContext(line: string): { model?: string; turnId?: string } | null {
  const parsed = JSON.parse(line) as {
    type?: string;
    payload?: { model?: string; turn_id?: string };
  };
  if (parsed.type !== "turn_context") return null;
  return {
    model: parsed.payload?.model,
    turnId: parsed.payload?.turn_id,
  };
}

export function parseTokenCountEvent(line: string, ctx: RolloutContext): ParsedCodexEvent | null {
  const parsed = JSON.parse(line) as {
    type?: string;
    timestamp?: string;
    payload?: {
      type?: string;
      info?: {
        last_token_usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cached_input_tokens?: number;
          reasoning_output_tokens?: number;
          total_tokens?: number;
        } | null;
        model?: string | null;
        total_token_usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cached_input_tokens?: number;
          reasoning_output_tokens?: number;
          total_tokens?: number;
        } | null;
      } | null;
    };
  };

  if (parsed.type !== "event_msg") return null;
  if (parsed.payload?.type !== "token_count") return null;

  const info = parsed.payload.info;
  if (!info) return null;
  const usage = info.last_token_usage;
  if (!usage) return null;

  const resolvedTimestampNanos = toUnixNanos(parsed.timestamp);
  if (!resolvedTimestampNanos) return null;

  const model = info.model || ctx.model || "unknown";
  const totalUsage = info.total_token_usage;
  const totalUsageKey = totalUsage
    ? [
        totalUsage.input_tokens ?? 0,
        totalUsage.output_tokens ?? 0,
        totalUsage.cached_input_tokens ?? 0,
        totalUsage.reasoning_output_tokens ?? 0,
        totalUsage.total_tokens ?? 0,
      ].join("|")
    : "missing-total";
  const lastUsageKey = [
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cached_input_tokens ?? 0,
    usage.reasoning_output_tokens ?? 0,
    usage.total_tokens ?? 0,
  ].join("|");

  return {
    sessionId: ctx.sessionId,
    serviceName: ctx.serviceName || CODEX_EXEC_SERVICE_NAME,
    resolvedTimestampNanos,
    model,
    inputs: usage.input_tokens ?? 0,
    outputs: usage.output_tokens ?? 0,
    cached: usage.cached_input_tokens ?? 0,
    reasoning: usage.reasoning_output_tokens ?? 0,
    toolTokens: 0,
    dedupeKey: ctx.turnId
      ? buildTurnDedupeKey(
          ctx.serviceName || CODEX_EXEC_SERVICE_NAME,
          ctx.sessionId,
          model,
          ctx.turnId,
        )
      : [
          "codex-token-count-value",
          ctx.serviceName || CODEX_EXEC_SERVICE_NAME,
          ctx.sessionId,
          model,
          totalUsageKey,
          lastUsageKey,
        ].join("|"),
  };
}

export function parseCompletedEvent(line: string, ctx?: RolloutContext): ParsedCodexEvent | null {
  const parsed = JSON.parse(line) as {
    type?: string;
    event?: string;
    sessionId?: string;
    session_id?: string;
    timestamp?: string;
    resolvedTimestampNanos?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      reasoning_tokens?: number;
      tool_token_count?: number;
    };
    data?: {
      response?: {
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          reasoning_tokens?: number;
          tool_token_count?: number;
        };
      };
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_tokens?: number;
        reasoning_tokens?: number;
        tool_token_count?: number;
      };
      timestamp?: string;
    };
  };

  const isCompleted = parsed.event === "response.completed" || parsed.type === "response.completed";
  if (!isCompleted) return null;

  const usage = parsed.data?.response?.usage ?? parsed.data?.usage ?? parsed.usage ?? {};
  const model =
    parsed.data?.response?.model ?? parsed.data?.model ?? parsed.model ?? ctx?.model ?? "unknown";
  const sessionId = parsed.session_id ?? parsed.sessionId ?? "unknown-session";
  const resolvedTimestampNanos =
    parsed.resolvedTimestampNanos ?? toUnixNanos(parsed.data?.timestamp ?? parsed.timestamp);
  if (!resolvedTimestampNanos) return null;

  const serviceName = ctx?.serviceName || CODEX_EXEC_SERVICE_NAME;

  return {
    sessionId,
    serviceName,
    resolvedTimestampNanos,
    model,
    inputs: usage.input_tokens ?? 0,
    outputs: usage.output_tokens ?? 0,
    cached: usage.cache_read_tokens ?? 0,
    reasoning: usage.reasoning_tokens ?? 0,
    toolTokens: usage.tool_token_count ?? 0,
    dedupeKey: ctx?.turnId
      ? buildTurnDedupeKey(serviceName, ctx.sessionId, model, ctx.turnId)
      : ["codex-completed-value", serviceName, sessionId, resolvedTimestampNanos].join("|"),
  };
}

function getBackfillEnvPath(configPath?: string): string {
  if (configPath) return join(dirname(configPath), REVENIUM_ENV_FILE);
  return join(homedir(), CODEX_CONFIG_DIR, REVENIUM_ENV_FILE);
}

async function loadBackfillResourceAttributes(configPath?: string): Promise<StringAttribute[]> {
  const envPath = getBackfillEnvPath(configPath);
  if (!existsSync(envPath)) return [];

  let env: Record<string, string>;
  try {
    env = parseEnvContent(await readFile(envPath, "utf-8"));
  } catch {
    return [];
  }

  const values = parseOtelResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES ?? "");

  if (!values["user.email"] && env.REVENIUM_SUBSCRIBER_EMAIL) {
    values["user.email"] = env.REVENIUM_SUBSCRIBER_EMAIL;
  }
  if (!values["organization.name"] && env.REVENIUM_ORGANIZATION_NAME) {
    values["organization.name"] = env.REVENIUM_ORGANIZATION_NAME;
  }
  if (!values["product.name"] && env.REVENIUM_PRODUCT_NAME) {
    values["product.name"] = env.REVENIUM_PRODUCT_NAME;
  }

  const excluded = new Set(["service.name", REVENIUM_API_KEY_ATTR]);
  return Object.entries(values)
    .filter(([key, value]) => !excluded.has(key) && value.trim().length > 0)
    .map(([key, value]) => ({ key, value: { stringValue: value } }));
}

function createPayload(
  batch: ParsedCodexEvent[],
  sharedResourceAttributes: StringAttribute[] = [],
): OTLPLogsPayload {
  const eventsByServiceName = new Map<string, ParsedCodexEvent[]>();
  for (const event of batch) {
    const serviceName = event.serviceName || CODEX_EXEC_SERVICE_NAME;
    const existing = eventsByServiceName.get(serviceName);
    if (existing) {
      existing.push(event);
    } else {
      eventsByServiceName.set(serviceName, [event]);
    }
  }

  const subscriberEmail = sharedResourceAttributes.find((a) => a.key === "user.email");
  const resourceAttrsWithoutEmail = sharedResourceAttributes.filter((a) => a.key !== "user.email");

  return {
    resourceLogs: Array.from(eventsByServiceName, ([serviceName, events]) => ({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: serviceName } },
          ...resourceAttrsWithoutEmail,
        ],
      },
      scopeLogs: [
        {
          scope: { name: "codex_otel.log_only", version: "1.0.0" },
          logRecords: events.map((event) => ({
            timeUnixNano: event.resolvedTimestampNanos,
            observedTimeUnixNano: event.resolvedTimestampNanos,
            body: { stringValue: "codex_cli.token_usage" },
            attributes: [
              { key: "event.name", value: { stringValue: "codex.sse_event" } },
              { key: "event.kind", value: { stringValue: "response.completed" } },
              { key: "transaction_id", value: { stringValue: hashTransactionId(event) } },
              { key: "conversation.id", value: { stringValue: event.sessionId } },
              { key: "model", value: { stringValue: event.model } },
              { key: "input_token_count", value: { intValue: event.inputs } },
              { key: "output_token_count", value: { intValue: event.outputs } },
              { key: "cached_token_count", value: { intValue: event.cached } },
              { key: "reasoning_token_count", value: { intValue: event.reasoning } },
              { key: "tool_token_count", value: { intValue: event.toolTokens } },
              { key: "duration_ms", value: { intValue: 0 } },
              ...(subscriberEmail ? [subscriberEmail] : []),
            ],
          })),
        },
      ],
    })),
  };
}

export async function backfillAction(options: BackfillOptions = {}): Promise<void> {
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  const cleanupSignals = (): void => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const parsedSince = parseDateInput(options.since);
  if (options.since !== undefined && parsedSince === null) {
    console.error(chalk.red(`Invalid --since value: "${options.since}"`));
    cleanupSignals();
    process.exit(1);
  }
  const parsedTo = parseDateInput(options.to);
  if (options.to !== undefined && parsedTo === null) {
    console.error(chalk.red(`Invalid --to value: "${options.to}"`));
    cleanupSignals();
    process.exit(1);
  }
  const sinceDate = parsedSince ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = parsedTo ?? new Date();
  if (sinceDate > toDate) {
    console.error(chalk.red("Invalid range: --since is after --to"));
    cleanupSignals();
    process.exit(1);
  }

  const rawBatchSize = options.batchSize;
  if (
    rawBatchSize !== undefined &&
    (!Number.isFinite(rawBatchSize) || !Number.isInteger(rawBatchSize) || rawBatchSize < 1)
  ) {
    console.error(
      chalk.red(`Invalid --batch-size: must be a positive integer, got: ${rawBatchSize}`),
    );
    cleanupSignals();
    process.exit(1);
  }
  const batchSize = Math.min(Math.max(rawBatchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const sessionsPath = options.sessionsPath ?? DEFAULT_SESSIONS_PATH;

  console.log(chalk.bold("\nRevenium Codex CLI Backfill\n"));
  console.log(chalk.dim(`Sessions path: ${sessionsPath}`));
  console.log(chalk.dim(`Date window: ${sinceDate.toISOString()} -> ${toDate.toISOString()}`));
  if (options.dryRun) {
    console.log(chalk.yellow("Running in dry-run mode - no data will be sent\n"));
  }

  const toml = await readCodexToml(options.configPath);
  const otelValues = toml ? extractOtelValues(toml) : null;
  if (!otelValues) {
    console.error(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-codex setup` first."));
    cleanupSignals();
    process.exit(1);
  }

  const scan = ora("Scanning Codex rollout files...").start();
  const files = await findRolloutFiles(sessionsPath).catch(() => [] as string[]);
  scan.succeed(`Found ${files.length} rollout file(s)`);

  const events: ParsedCodexEvent[] = [];
  let malformed = 0;
  for (const filePath of files) {
    const stream = createReadStream(filePath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const ctx: RolloutContext = {
      sessionId: "unknown-session",
      model: "unknown",
      serviceName: CODEX_EXEC_SERVICE_NAME,
    };
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const meta = parseSessionMeta(line);
        if (meta) {
          ctx.sessionId = meta.sessionId;
          ctx.serviceName = meta.serviceName;
          ctx.turnId = undefined;
          continue;
        }
        const turnContext = parseTurnContext(line);
        if (turnContext) {
          ctx.turnId = turnContext.turnId;
          if (turnContext.model) {
            ctx.model = turnContext.model;
          }
          continue;
        }
        const tokenCountEvent = parseTokenCountEvent(line, ctx);
        const completedEvent = tokenCountEvent ? null : parseCompletedEvent(line, ctx);
        if (completedEvent) {
          ctx.turnId = undefined;
        }
        const event = tokenCountEvent ?? completedEvent;
        if (!event) continue;
        const ms = Number(event.resolvedTimestampNanos.slice(0, -6));
        if (!Number.isFinite(ms)) continue;
        const dt = new Date(ms);
        if (dt < sinceDate || dt > toDate) continue;
        events.push(event);
      } catch {
        malformed++;
      }
    }
    rl.close();
    stream.destroy();
  }

  console.log(chalk.bold("\nSummary:"));
  console.log(`  Files scanned:   ${files.length}`);
  console.log(`  Events parsed:   ${events.length}`);
  console.log(`  Malformed lines: ${malformed}`);
  if (events.length === 0) {
    console.log(chalk.yellow("\nNo matching events found."));
    cleanupSignals();
    return;
  }

  const { events: backfillEvents, duplicateCount } = deduplicateCodexEvents(events);
  if (duplicateCount > 0) {
    console.log(`  Duplicates:      ${duplicateCount.toLocaleString()}`);
  }

  if (options.dryRun) {
    console.log(`  Would send:      ${backfillEvents.length}`);
    if (options.verbose) {
      console.log(chalk.dim("\nSample event:"));
      console.log(chalk.dim(JSON.stringify(backfillEvents[0], null, 2)));
    }
    cleanupSignals();
    return;
  }

  const resourceAttributes = await loadBackfillResourceAttributes(options.configPath);

  const spinner = ora("Sending backfill payloads...").start();
  await startupStagger();
  const totalBatches = Math.ceil(backfillEvents.length / batchSize);
  let sent = 0;
  try {
    for (let i = 0; i < backfillEvents.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      if (interrupted) {
        spinner.stop();
        console.log(
          chalk.yellow(
            `Backfill interrupted at batch ${batchNum}/${totalBatches}; safe to re-run (transaction_id-keyed server dedup)`,
          ),
        );
        cleanupSignals();
        process.exit(130);
      }
      const batch = backfillEvents.slice(i, i + batchSize);
      await sendOtlpLogs(
        otelValues.endpoint,
        otelValues.apiKey,
        createPayload(batch, resourceAttributes),
        { batchSize: batch.length },
      );
      sent += batch.length;
      spinner.text = `Sending backfill payloads... (${sent}/${backfillEvents.length})`;
    }
    spinner.succeed(`Backfill complete: sent ${sent} event(s)`);
  } catch (error) {
    spinner.fail(`Backfill failed after sending ${sent}/${backfillEvents.length} event(s)`);
    console.error(
      chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`),
    );
    console.log(
      chalk.yellow(
        "\nBackfill is safe to re-run; server-side transaction_id dedup prevents duplicates.",
      ),
    );
    process.exit(1);
  } finally {
    cleanupSignals();
  }
}
