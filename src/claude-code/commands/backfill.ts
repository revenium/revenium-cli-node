import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../config/loader.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { getCostMultiplier, type SubscriptionTier } from "../constants.js";
import type { OTLPLogsPayload } from "../../_core/types/index.js";

export interface BackfillOptions {
  since?: string;
  dryRun?: boolean;
  batchSize?: number;
  delay?: number;
  verbose?: boolean;
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface JsonlEntry {
  type: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: UsageData;
  };
}

interface ParsedRecord {
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

interface RetryResult {
  success: boolean;
  attempts: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isRetryableError(errorMsg: string): boolean {
  const statusMatch = errorMsg.match(/OTLP request failed: (\d{3})/);
  if (!statusMatch) return true;

  const statusCode = parseInt(statusMatch[1], 10);
  if (statusCode === 429) return true;
  if (statusCode >= 400 && statusCode < 500) return false;
  return true;
}

async function sendBatchWithRetry(
  endpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
  maxRetries: number,
  verbose: boolean,
): Promise<RetryResult> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sendOtlpLogs(endpoint, apiKey, payload);
      return { success: true, attempts: attempt + 1 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      if (!isRetryableError(errorMsg)) {
        if (verbose) {
          console.log(chalk.red(`  Non-retryable error: ${errorMsg}`));
        }
        return { success: false, attempts: attempt + 1, error: errorMsg };
      }

      if (attempt < maxRetries - 1) {
        const backoffDelay = 1000 * Math.pow(2, attempt);
        if (verbose) {
          console.log(chalk.yellow(`  Attempt ${attempt + 1} failed: ${errorMsg}`));
        }
        await sleep(backoffDelay);
      } else {
        return { success: false, attempts: maxRetries, error: errorMsg };
      }
    }
  }

  return { success: false, attempts: maxRetries };
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
  const { timestamp, sessionId } = entry;
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

function createOtlpPayload(
  records: ParsedRecord[],
  options: {
    costMultiplier: number;
    email?: string;
    organizationName?: string;
    productName?: string;
  },
): OTLPLogsPayload {
  const { costMultiplier, email, organizationName, productName } = options;

  const logRecords = records
    .map((record) => {
      const timeUnixNano = toUnixNano(record.timestamp);
      if (timeUnixNano === null) return null;

      const attributes: Array<{
        key: string;
        value: { stringValue?: string; intValue?: number };
      }> = [
        {
          key: "transaction_id",
          value: { stringValue: generateTransactionId(record) },
        },
        { key: "session.id", value: { stringValue: record.sessionId } },
        { key: "model", value: { stringValue: record.model } },
        { key: "input_tokens", value: { intValue: record.inputTokens } },
        { key: "output_tokens", value: { intValue: record.outputTokens } },
        {
          key: "cache_read_tokens",
          value: { intValue: record.cacheReadTokens },
        },
        {
          key: "cache_creation_tokens",
          value: { intValue: record.cacheCreationTokens },
        },
      ];

      if (email) {
        attributes.push({ key: "user.email", value: { stringValue: email } });
      }
      if (organizationName) {
        attributes.push({
          key: "organization.name",
          value: { stringValue: organizationName },
        });
      }
      if (productName) {
        attributes.push({
          key: "product.name",
          value: { stringValue: productName },
        });
      }

      return { timeUnixNano, body: { stringValue: "claude_code.api_request" }, attributes };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
            { key: "cost_multiplier", value: { doubleValue: costMultiplier } },
          ],
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

export async function backfillCommand(options: BackfillOptions = {}): Promise<void> {
  const { since, dryRun = false, batchSize = 100, delay = 100, verbose = false } = options;

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

  const costMultiplier =
    config.costMultiplierOverride ??
    (config.subscriptionTier
      ? getCostMultiplier(config.subscriptionTier as SubscriptionTier)
      : 0.08);

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

  const sorted = [...allRecords].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const totalInput = allRecords.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = allRecords.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheRead = allRecords.reduce((s, r) => s + r.cacheReadTokens, 0);
  const totalCacheCreation = allRecords.reduce((s, r) => s + r.cacheCreationTokens, 0);

  console.log("\n" + chalk.bold("Summary:"));
  console.log(`  Records:              ${allRecords.length.toLocaleString()}`);
  console.log(
    `  Date range:           ${sorted[0].timestamp.split("T")[0]} to ${sorted[sorted.length - 1].timestamp.split("T")[0]}`,
  );
  console.log(`  Input tokens:         ${totalInput.toLocaleString()}`);
  console.log(`  Output tokens:        ${totalOutput.toLocaleString()}`);
  console.log(`  Cache read tokens:    ${totalCacheRead.toLocaleString()}`);
  console.log(`  Cache creation:       ${totalCacheCreation.toLocaleString()}`);
  console.log(`  Cost multiplier:      ${costMultiplier}`);

  if (dryRun) {
    console.log("\n" + chalk.yellow("Dry run complete. Use without --dry-run to send data."));
    return;
  }

  const totalBatches = Math.ceil(allRecords.length / batchSize);
  const sendSpinner = ora(`Sending data... (0/${totalBatches} batches)`).start();
  let sentBatches = 0;
  let sentRecords = 0;
  let permanentlyFailedBatches = 0;
  const failedBatchDetails: Array<{ batchNumber: number; error: string }> = [];

  for (let i = 0; i < allRecords.length; i += batchSize) {
    const batchNumber = Math.floor(i / batchSize) + 1;
    const batch = allRecords.slice(i, i + batchSize);
    const payload = createOtlpPayload(batch, {
      costMultiplier,
      email: config.email,
      organizationName: config.organizationName || config.organizationId,
      productName: config.productName || config.productId,
    });

    sendSpinner.text = `Sending batch ${batchNumber}/${totalBatches}...`;

    const result = await sendBatchWithRetry(config.endpoint, config.apiKey, payload, 3, verbose);

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

    if (i + batchSize < allRecords.length) {
      await sleep(delay);
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
