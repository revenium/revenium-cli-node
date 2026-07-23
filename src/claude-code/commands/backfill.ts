import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { loadConfig } from "../config/loader.js";
import { MIDDLEWARE_SOURCE_KEY, MIDDLEWARE_SOURCE_CLI } from "../constants.js";
import { MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE } from "../../_core/api/rate-limiter.js";
import { sendLogsWithResult } from "../../_core/api/otlp-client.js";
import { startupStagger } from "../../_core/api/resilience.js";
import { validateEmail } from "../../_core/config/validator.js";
import { maskEmail } from "../../_core/utils/masking.js";
import type { OTLPLogsPayload } from "../../_core/types/index.js";

export interface BackfillOptions {
  since?: string;
  dryRun?: boolean;
  batchSize?: number;
  delay?: number;
  verbose?: boolean;
  email?: string;
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface JsonlEntry {
  type: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: UsageData;
  };
}

export interface ParsedRecord {
  requestId?: string;
  messageId?: string;
  sessionId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface StreamResult {
  record?: ParsedRecord;
  parseError?: boolean;
  missingFields?: boolean;
}

function generateTransactionId(record: ParsedRecord): string {
  const input = [
    record.sessionId,
    record.timestamp,
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheCreationTokens,
  ].join("|");

  return createHash("sha256").update(input).digest("hex").substring(0, 32);
}

function getRecordDedupKey(record: ParsedRecord): string | null {
  if (!record.requestId || !record.messageId) return null;
  return [record.requestId, record.messageId].join("|");
}

export function deduplicateRecords(records: ParsedRecord[]): {
  records: ParsedRecord[];
  duplicateCount: number;
} {
  const deduped = new Map<string, ParsedRecord>();
  const passthrough: ParsedRecord[] = [];
  let duplicateCount = 0;

  for (const record of records) {
    const key = getRecordDedupKey(record);
    if (!key) {
      passthrough.push(record);
      continue;
    }

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, record);
      continue;
    }

    duplicateCount++;
    if (new Date(record.timestamp).getTime() >= new Date(existing.timestamp).getTime()) {
      deduped.set(key, record);
    }
  }

  return { records: [...passthrough, ...deduped.values()], duplicateCount };
}

function parseRelativeDate(input: string): Date | null {
  const match = input.match(/^(\d+)([dmwMy])$/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
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

function parseSinceDate(since: string): Date | null {
  const relativeDate = parseRelativeDate(since);
  if (relativeDate) return relativeDate;

  const isoDate = new Date(since);
  if (!isNaN(isoDate.getTime())) return isoDate;

  return null;
}

async function findJsonlFiles(
  dir: string,
  errors: string[] = [],
): Promise<{ files: string[]; errors: string[] }> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const result = await findJsonlFiles(fullPath, errors);
        files.push(...result.files);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${dir}: ${message}`);
  }

  return { files, errors };
}

function parseJsonlLine(line: string, sinceDate: Date | null): StreamResult {
  if (!line.trim()) return {};

  let entry: JsonlEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { parseError: true };
  }

  if (entry.type !== "assistant" || !entry.message?.usage) return {};

  const usage = entry.message.usage;
  const { requestId, timestamp, sessionId } = entry;
  const messageId = entry.message.id;
  const model = entry.message.model;

  if (!timestamp || !sessionId || !model) return { missingFields: true };

  const entryDate = new Date(timestamp);
  if (!Number.isFinite(entryDate.getTime())) return {};
  if (sinceDate && entryDate < sinceDate) return {};

  const totalTokens =
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);

  if (totalTokens === 0) return {};

  return {
    record: {
      requestId,
      messageId,
      sessionId,
      timestamp,
      model,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    },
  };
}

async function* streamJsonlRecords(
  filePath: string,
  sinceDate: Date | null,
): AsyncGenerator<StreamResult> {
  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const result = parseJsonlLine(line, sinceDate);
      if (result.record || result.parseError || result.missingFields) {
        yield result;
      }
    }
  } finally {
    fileStream.destroy();
    rl.close();
  }
}

function toUnixNano(timestamp: string): string | null {
  const date = new Date(timestamp);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return (BigInt(ms) * BigInt(1_000_000)).toString();
}

export function createOtlpPayload(
  records: ParsedRecord[],
  options: {
    email?: string;
    organizationName?: string;
    productName?: string;
  },
): OTLPLogsPayload {
  const { email, organizationName, productName } = options;

  const logRecords = records
    .map((record) => {
      const timeUnixNano = toUnixNano(record.timestamp);
      if (timeUnixNano === null) return null;

      const attributes: Array<{
        key: string;
        value: { stringValue: string };
      }> = [
        {
          key: "transaction_id",
          value: { stringValue: generateTransactionId(record) },
        },
        { key: "session.id", value: { stringValue: record.sessionId } },
        { key: "model", value: { stringValue: record.model } },
        { key: "input_tokens", value: { stringValue: String(record.inputTokens) } },
        { key: "output_tokens", value: { stringValue: String(record.outputTokens) } },
        {
          key: "cache_read_tokens",
          value: { stringValue: String(record.cacheReadTokens) },
        },
        {
          key: "cache_creation_tokens",
          value: { stringValue: String(record.cacheCreationTokens) },
        },
      ];

      if (record.requestId) {
        attributes.push({ key: "request_id", value: { stringValue: record.requestId } });
      }
      if (record.messageId) {
        attributes.push({ key: "message.id", value: { stringValue: record.messageId } });
      }

      if (email) {
        attributes.push({ key: "user.email", value: { stringValue: email } });
      }

      return { timeUnixNano, body: { stringValue: "claude_code.api_request" }, attributes };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const resourceAttributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: "service.name", value: { stringValue: "claude-code" } },
    { key: MIDDLEWARE_SOURCE_KEY, value: { stringValue: MIDDLEWARE_SOURCE_CLI } },
  ];

  if (organizationName) {
    resourceAttributes.push({ key: "organization.name", value: { stringValue: organizationName } });
  }
  if (productName) {
    resourceAttributes.push({ key: "product.name", value: { stringValue: productName } });
  }

  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes,
        },
        scopeLogs: [
          {
            scope: { name: "claude-code", version: "1.0.0" },
            logRecords,
          },
        ],
      },
    ],
  };
}

export async function resolveBackfillEmail(
  flagEmail: string | undefined,
  configEmail: string | undefined,
): Promise<string | undefined> {
  const trimmedFlagEmail = flagEmail?.trim();
  if (trimmedFlagEmail) {
    const result = validateEmail(trimmedFlagEmail);
    if (!result.valid) {
      throw new Error(`Invalid --email: ${result.errors.join(", ")}`);
    }
    return trimmedFlagEmail;
  }

  if (configEmail) {
    return configEmail;
  }

  if (!process.stdin.isTTY) {
    console.log(
      chalk.yellow(
        "No email configured and no --email provided; backfilled usage will be unattributed.",
      ),
    );
    return undefined;
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "email",
      message: "Email to attribute this historical usage to (leave blank to skip):",
      validate: (input: string) => {
        if (!input) return true;
        const result = validateEmail(input);
        return result.valid || result.errors.join(", ");
      },
    },
  ]);
  const trimmed = (answers.email || "").trim();
  if (!trimmed) {
    console.log(chalk.yellow("No email entered; backfilled usage will be unattributed."));
    return undefined;
  }
  return trimmed;
}

export async function backfillCommand(options: BackfillOptions = {}): Promise<void> {
  const {
    since,
    dryRun = false,
    batchSize: rawBatchSize = DEFAULT_BATCH_SIZE,
    delay = 0,
    verbose = false,
  } = options;

  if (!Number.isInteger(rawBatchSize) || rawBatchSize < 1) {
    console.log(chalk.red("Error: --batch-size must be a positive integer"));
    process.exit(1);
  }

  const batchSize = Math.min(rawBatchSize, MAX_BATCH_SIZE);
  if (rawBatchSize > MAX_BATCH_SIZE) {
    console.log(
      chalk.yellow(
        `batch-size=${rawBatchSize} exceeds maximum of ${MAX_BATCH_SIZE}. Using ${MAX_BATCH_SIZE}.`,
      ),
    );
  }

  console.log(chalk.bold("\nRevenium Claude Code Backfill\n"));

  if (dryRun) {
    console.log(chalk.yellow("Running in dry-run mode - no data will be sent\n"));
  }

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("\nRun `revenium-metering setup` to configure Claude Code metering."));
    process.exit(1);
  }

  let sinceDate: Date | null = null;
  if (since) {
    sinceDate = parseSinceDate(since);
    if (!sinceDate) {
      console.log(chalk.red(`Invalid --since value: ${since}`));
      console.log(chalk.dim("Use ISO format (2024-01-15) or relative format (7d, 1m, 1y)"));
      process.exit(1);
    }
    console.log(chalk.dim(`Filtering records since: ${sinceDate.toISOString()}\n`));
  }

  const projectsDir = join(homedir(), ".claude", "projects");
  const discoverSpinner = ora("Discovering JSONL files...").start();

  const { files: jsonlFiles, errors: discoveryErrors } = await findJsonlFiles(projectsDir);

  if (jsonlFiles.length === 0) {
    discoverSpinner.fail("No JSONL files found");
    console.log(chalk.dim(`Searched in: ${projectsDir}`));
    process.exit(1);
  } else {
    discoverSpinner.succeed(`Found ${jsonlFiles.length} JSONL file(s)`);
  }

  if (verbose && discoveryErrors.length > 0) {
    console.log(chalk.yellow("\nDirectory access errors:"));
    for (const error of discoveryErrors.slice(0, 5)) {
      console.log(chalk.yellow(`  ${error}`));
    }
  }

  const processSpinner = ora("Processing files...").start();
  const allRecords: ParsedRecord[] = [];
  let processedFiles = 0;
  let skippedLines = 0;
  let skippedMissingFields = 0;

  for (const file of jsonlFiles) {
    try {
      for await (const result of streamJsonlRecords(file, sinceDate)) {
        if (result.parseError) {
          skippedLines++;
        } else if (result.missingFields) {
          skippedMissingFields++;
        } else if (result.record) {
          allRecords.push(result.record);
        }
      }
      processedFiles++;
      processSpinner.text = `Processing files... (${processedFiles}/${jsonlFiles.length})`;
    } catch (error) {
      if (verbose) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.yellow(`\nWarning: Could not process ${file}: ${message}`));
      }
    }
  }

  let statusMessage = `Processed ${processedFiles} files, found ${allRecords.length} usage records`;
  if (skippedLines > 0) {
    statusMessage += chalk.yellow(` (${skippedLines} malformed lines skipped)`);
  }
  if (skippedMissingFields > 0) {
    statusMessage += chalk.yellow(` (${skippedMissingFields} records missing required fields)`);
  }

  processSpinner.succeed(statusMessage);

  if (allRecords.length === 0) {
    console.log(chalk.yellow("\nNo usage records found to backfill."));
    return;
  }

  const { records: backfillRecords, duplicateCount } = deduplicateRecords(allRecords);

  const sorted = [...backfillRecords].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const totalInput = backfillRecords.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = backfillRecords.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheRead = backfillRecords.reduce((s, r) => s + r.cacheReadTokens, 0);
  const totalCacheCreation = backfillRecords.reduce((s, r) => s + r.cacheCreationTokens, 0);

  console.log("\n" + chalk.bold("Summary:"));
  console.log(`  Records found:        ${allRecords.length.toLocaleString()}`);
  console.log(`  Records to backfill:  ${backfillRecords.length.toLocaleString()}`);
  if (duplicateCount > 0) {
    console.log(`  Duplicates skipped:   ${duplicateCount.toLocaleString()}`);
  }
  console.log(
    `  Date range:           ${sorted[0].timestamp.split("T")[0]} to ${sorted[sorted.length - 1].timestamp.split("T")[0]}`,
  );
  console.log(`  Input tokens:         ${totalInput.toLocaleString()}`);
  console.log(`  Output tokens:        ${totalOutput.toLocaleString()}`);
  console.log(`  Cache read tokens:    ${totalCacheRead.toLocaleString()}`);
  console.log(`  Cache creation:       ${totalCacheCreation.toLocaleString()}`);

  if (dryRun) {
    console.log("\n" + chalk.yellow("Dry run complete. Use without --dry-run to send data."));
    return;
  }

  let email: string | undefined;
  try {
    email = await resolveBackfillEmail(options.email, config.email);
  } catch (error) {
    console.log(chalk.red(error instanceof Error ? error.message : "Invalid --email"));
    process.exit(1);
  }
  if (email) {
    console.log(chalk.dim(`Attributing backfilled usage to: ${maskEmail(email)}`));
  }

  const totalBatches = Math.ceil(backfillRecords.length / batchSize);
  const sendSpinner = ora(`Sending data... (0/${totalBatches} batches)`).start();
  await startupStagger();
  let sentBatches = 0;
  let sentRecords = 0;
  let permanentlyFailedBatches = 0;
  const failedBatchDetails: Array<{ batchNumber: number; error: string }> = [];
  for (let i = 0; i < backfillRecords.length; i += batchSize) {
    const batchNumber = Math.floor(i / batchSize) + 1;
    const batch = backfillRecords.slice(i, i + batchSize);
    const payload = createOtlpPayload(batch, {
      email,
      organizationName: config.organizationName,
      productName: config.productName,
    });

    sendSpinner.text = `Sending batch ${batchNumber}/${totalBatches}...`;

    const result = await sendLogsWithResult(config.endpoint, config.apiKey, payload, {
      batchSize: batch.length,
      userDelayMs: delay,
    });

    if (result.success) {
      sentBatches++;
      sentRecords += batch.length;
      sendSpinner.text = `Sending data... (${sentBatches}/${totalBatches} batches)`;
    } else {
      permanentlyFailedBatches++;
      failedBatchDetails.push({
        batchNumber,
        error: result.error || "Unknown error",
      });
    }
  }

  if (permanentlyFailedBatches === 0) {
    sendSpinner.succeed(`Sent ${sentRecords.toLocaleString()} records in ${sentBatches} batches`);
  } else {
    sendSpinner.warn(
      `Sent ${sentRecords.toLocaleString()} records in ${sentBatches} batches (${permanentlyFailedBatches} failed)`,
    );

    console.log("\n" + chalk.red.bold("Failed Batches:"));
    for (const failed of failedBatchDetails) {
      console.log(chalk.red(`  Batch ${failed.batchNumber}: ${failed.error}`));
    }
  }

  console.log("\n" + chalk.green.bold("Backfill complete!"));
  console.log(chalk.dim("Check your Revenium dashboard to see the imported data."));
}
