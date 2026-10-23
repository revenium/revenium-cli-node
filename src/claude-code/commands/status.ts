import chalk from "chalk";
import ora from "ora";
import {
  loadConfig,
  configExists,
  getConfigPath,
  isCursorProvidedConfig,
} from "../config/loader.js";
import {
  applyTelemetryEnv,
  readTelemetryEnvSources,
  resolveLogToolDetails,
} from "../config/claude-settings.js";
import type { LogToolDetailsResolution, TelemetryEnvReport } from "../config/claude-settings.js";
import type { ClaudeCodeConfig } from "../config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { ENV_VARS } from "../constants.js";

export interface StatusOptions {
  fix?: boolean;
}

async function applyTelemetryFix(config: ClaudeCodeConfig): Promise<void> {
  const result = await applyTelemetryEnv(config);

  if (result.applied) {
    console.log(chalk.green(`  Re-applied the telemetry settings to ${result.path}`));
    console.log(chalk.dim("  Start a new Claude Code session to pick them up."));
    return;
  }

  console.log(chalk.yellow(`  Could not update ${result.path}: ${result.error}`));
}

function reportTelemetry(report: TelemetryEnvReport): void {
  if (report.error) {
    console.log(chalk.red(`  Could not read ${report.path}: ${report.error}`));
    return;
  }

  const enabled =
    report.env[ENV_VARS.TELEMETRY_ENABLED] === "1" && !!report.env[ENV_VARS.OTLP_ENDPOINT];

  if (enabled) {
    console.log(chalk.green(`  Telemetry is enabled for Claude Code in ${report.path}`));
  } else {
    console.log(chalk.yellow(`  Telemetry is not enabled for Claude Code in ${report.path}`));
    console.log(chalk.dim("  Run: revenium-metering setup"));
  }
}

function describeResolutionSource(
  envValue: string | undefined,
  resolved: LogToolDetailsResolution,
): string {
  if (resolved.unreadablePath) return `could not read ${resolved.unreadablePath}`;
  return envValue === undefined
    ? "OTEL_LOG_TOOL_DETAILS unset"
    : `OTEL_LOG_TOOL_DETAILS=${envValue}`;
}

// The backfill half of this message comes from the same resolution backfill itself uses, so the two
// commands cannot disagree about whether an import carries skill names.
function reportSkillNames(report: TelemetryEnvReport, resolved: LogToolDetailsResolution): void {
  const envValue = report.env[ENV_VARS.LOG_TOOL_DETAILS];
  const live = envValue === "1" ? "reported in live telemetry" : "redacted in live telemetry";
  const backfill = resolved.value === false ? "withheld from backfill" : "imported by backfill";
  const source = describeResolutionSource(envValue, resolved);
  const line = `  Skill names: ${live}, ${backfill} (${source})`;

  if (envValue === "1" && resolved.value === true) {
    console.log(chalk.green(line));
    return;
  }

  console.log(chalk.yellow(line));

  if (envValue === "0") {
    console.log(
      chalk.dim("  Re-run setup without --no-log-tool-details to attribute plugin skill usage."),
    );
    return;
  }

  if (!resolved.unreadablePath) {
    console.log(chalk.dim("  Run: revenium-metering status --fix"));
  }
}

function reportCursorProvidedConfig(): void {
  console.log("\n" + chalk.bold("Claude Code settings:"));
  console.log(chalk.dim("  This configuration was written by the Cursor setup."));
  console.log(chalk.dim("  Claude Code telemetry settings were not checked."));
}

function reportCursorRepairRefusal(): void {
  console.log(
    chalk.yellow("  Nothing to repair: this configuration was written by the Cursor setup."),
  );
  console.log(chalk.dim("  Run `revenium-metering setup` to also meter Claude Code."));
}

function reportManagedOverrides(managed: TelemetryEnvReport): void {
  const overridden = Object.keys(managed.env);
  if (overridden.length === 0) return;

  console.log(
    chalk.yellow(`  ${managed.path} overrides: ${overridden.sort().join(", ")}`) +
      chalk.dim(" (managed by your organization; this CLI never rewrites it)"),
  );
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Claude Code Metering Status\n"));

  const configPath = getConfigPath();
  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.dim(`Expected at: ${configPath}`));
    console.log(chalk.yellow("\nRun `revenium-metering setup` to configure Claude Code metering."));
    process.exit(1);
  }

  console.log(chalk.green("Configuration file found"));
  console.log(chalk.dim(`  ${configPath}`));

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("\nCould not parse configuration file"));
    console.log(chalk.yellow("Run `revenium-metering setup` to reconfigure."));
    process.exit(1);
  }

  console.log("\n" + chalk.bold("Configuration:"));
  console.log(`  API Key:    ${maskApiKey(config.apiKey)}`);
  console.log(`  Endpoint:   ${config.endpoint}`);
  if (config.email) {
    console.log(`  Email:      ${maskEmail(config.email)}`);
  }
  const organizationValue = config.organizationName;
  if (organizationValue) {
    console.log(`  Organization: ${organizationValue}`);
  }
  const productValue = config.productName;
  if (productValue) {
    console.log(`  Product:    ${productValue}`);
  }

  const cursorProvided = isCursorProvidedConfig();

  if (options.fix) {
    console.log("\n" + chalk.bold("Repair:"));
    if (cursorProvided) {
      reportCursorRepairRefusal();
    } else {
      await applyTelemetryFix(config);
    }
  }

  if (cursorProvided) {
    reportCursorProvidedConfig();
  } else {
    const { managed, effective } = await readTelemetryEnvSources();

    console.log("\n" + chalk.bold("Claude Code settings:"));
    reportTelemetry(effective);
    reportManagedOverrides(managed);

    console.log("\n" + chalk.bold("Skill attribution:"));
    reportSkillNames(effective, await resolveLogToolDetails(config));
  }

  console.log("\n" + chalk.bold("Endpoint Health:"));
  const spinner = ora("  Testing connectivity...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "claude-code", {
      organizationName: config.organizationName,
      productName: config.productName,
    });

    if (healthResult.healthy) {
      spinner.succeed(`  Endpoint healthy (${healthResult.latencyMs}ms)`);
    } else {
      spinner.fail(`  Endpoint unhealthy: ${healthResult.message}`);
    }
  } catch (error) {
    spinner.fail(
      `  Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  console.log("");
}
