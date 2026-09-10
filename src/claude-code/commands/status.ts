import chalk from "chalk";
import ora from "ora";
import {
  loadConfig,
  configExists,
  isEnvLoaded,
  isToolDetailsLoaded,
  isToolDetailsExplicitlyDisabled,
  getConfigPath,
  getFishConfigPath,
} from "../config/loader.js";
import type { ClaudeCodeConfig } from "../config/loader.js";
import { ensureToolDetailsExport } from "../config/writer.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import { detectShell, getProfilePath } from "../../_core/shell/detector.js";

export interface StatusOptions {
  fix?: boolean;
}

// Derives the file to tell the user to `source` from the path actually in use (which may be a
// REVENIUM_CONFIG_PATH override or the Cursor fallback), not a hardcoded default. Sourcing the
// wrong file leaves the flag unloaded even after `status --fix` upgrades the real one.
function getSourceFileHint(configPath: string): string {
  return process.env.SHELL?.includes("fish") ? getFishConfigPath(configPath) : configPath;
}

async function applyToolDetailsFix(configPath: string): Promise<void> {
  const results = await ensureToolDetailsExport();
  const added = results.filter((result) => result.status === "added");

  if (added.length === 0) {
    console.log(chalk.dim("  Nothing to fix: OTEL_LOG_TOOL_DETAILS is already set in the config."));
    return;
  }

  for (const result of added) {
    console.log(chalk.green(`  Added OTEL_LOG_TOOL_DETAILS=1 to ${result.path}`));
  }
  console.log(chalk.dim(`  Run: source ${getSourceFileHint(configPath)}`));
}

function reportSkillNames(config: ClaudeCodeConfig, configPath: string): void {
  if (isToolDetailsLoaded()) {
    console.log(chalk.green("  Skill names: reported (OTEL_LOG_TOOL_DETAILS=1)"));
    return;
  }

  // Checked before the config-file states below: an explicit shell-level `=0` is an active,
  // deliberate opt-out and must not be reported as merely "unset", even when the config file on
  // disk has the flag enabled, because the process-level value wins once the file is sourced.
  if (isToolDetailsExplicitlyDisabled()) {
    console.log(
      chalk.yellow("  Skill names: redacted (OTEL_LOG_TOOL_DETAILS=0 in the current shell)"),
    );
    console.log(
      chalk.dim(
        "  This shell explicitly disables tool-detail export; unset it to attribute plugin skill usage.",
      ),
    );
    return;
  }

  if (config.logToolDetails === false) {
    console.log(
      chalk.yellow("  Skill names: redacted (OTEL_LOG_TOOL_DETAILS=0 in the config file)"),
    );
    console.log(
      chalk.dim(
        "  Set it to 1 to attribute plugin skill usage, or re-run setup without --no-log-tool-details.",
      ),
    );
    return;
  }

  if (config.logToolDetails === true) {
    console.log(
      chalk.yellow("  Skill names: redacted (OTEL_LOG_TOOL_DETAILS unset in this shell)"),
    );
    console.log(chalk.dim(`  Run: source ${getSourceFileHint(configPath)}`));
    return;
  }

  console.log(chalk.yellow("  Skill names: redacted (OTEL_LOG_TOOL_DETAILS unset)"));
  console.log(chalk.dim("  Run: revenium-metering status --fix"));
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

  console.log("\n" + chalk.bold("Environment:"));
  if (isEnvLoaded()) {
    console.log(chalk.green("  Environment variables are loaded in current shell"));
  } else {
    console.log(chalk.yellow("  Environment variables not loaded in current shell"));
    console.log(chalk.dim(`  Run: source ${getSourceFileHint(configPath)}`));
  }

  const shellType = detectShell();
  const profilePath = getProfilePath(shellType);
  console.log(`  Shell:      ${shellType}`);
  if (profilePath) {
    console.log(`  Profile:    ${profilePath}`);
  }

  if (options.fix) {
    console.log("\n" + chalk.bold("Repair:"));
    await applyToolDetailsFix(configPath);
  }

  console.log("\n" + chalk.bold("Skill attribution:"));
  reportSkillNames(options.fix ? ((await loadConfig()) ?? config) : config, configPath);

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
