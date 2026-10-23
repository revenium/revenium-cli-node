import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  validateOrganizationName,
  validateProductName,
} from "../../_core/config/validator.js";
import { enforceSetupFlags, enforceSetupInputs } from "../../_core/config/setup-input-gate.js";
import { firstNonEmpty } from "../../_core/utils/optional-text.js";
import { isInteractive, requireOptions } from "../../_core/ui/interactive.js";
import { checkPayloadDelivery, generateTestSessionId } from "../../_core/api/health-check.js";
import { updateShellProfile, getManualInstructions } from "../../_core/shell/profile-updater.js";
import type { ProfileUpdaterConfig } from "../../_core/shell/profile-updater.js";
import { createCodexMapperTestPayload } from "../payloads/test-payload.js";
import { getReveniumEnvPath, readCodexToml } from "../config/loader.js";
import { getWrapperFunction, WRAPPER_COMMAND } from "../shell/wrapper.js";
import { SHELL_PROFILE_MARKER } from "../constants.js";
import { findOtelEntries } from "../config/otel-entries.js";
import type { OtelEntry } from "../config/otel-entries.js";
import {
  generateTomlBlock,
  resolveBaseEndpoint,
  writeCodexToml,
  writeReveniumEnv,
} from "../config/writer.js";
import type { CodexOtelConfig } from "../config/writer.js";

interface SetupOptions {
  apiKey?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  endpoint?: string;
  configPath?: string;
  force?: boolean;
  skipShellUpdate?: boolean;
  logToolDetails?: boolean;
}

async function verifyEndpointAcceptsUsage(config: CodexOtelConfig): Promise<boolean> {
  const spinner = ora("Testing API key...").start();

  try {
    const health = await checkPayloadDelivery(
      resolveBaseEndpoint(config),
      config.apiKey,
      createCodexMapperTestPayload(generateTestSessionId()),
    );

    if (!health.healthy) {
      spinner.fail(`API key validation failed: ${health.message}`);
      return false;
    }

    spinner.succeed(`API key validated (${health.latencyMs}ms latency)`);
    return true;
  } catch (error) {
    spinner.fail("Failed to validate API key");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    return false;
  }
}

function describeOtelEntries(entries: OtelEntry[]): string {
  return entries.map((entry) => `${entry.name} (line ${entry.line})`).join(", ");
}

function buildProfileUpdaterConfig(configPath?: string): ProfileUpdaterConfig {
  return {
    markerName: SHELL_PROFILE_MARKER,
    getSourceCommand: (shellType) => getWrapperFunction(shellType, configPath),
    getConfigFilePath: () => getReveniumEnvPath(configPath),
    pruneOtherProfiles: true,
  };
}

async function installShellWrapper(config: ProfileUpdaterConfig): Promise<boolean> {
  const spinner = ora("Updating shell profile...").start();

  try {
    const result = await updateShellProfile(config);

    if (result.success) {
      spinner.succeed(result.message);
      return true;
    }

    spinner.warn(result.message);
  } catch {
    spinner.warn("Could not update shell profile automatically");
  }

  return false;
}

function describeAttributionReach(
  wrapperInstalled: boolean,
  config: ProfileUpdaterConfig,
  configPath?: string,
): string {
  if (wrapperInstalled) {
    return "Organization and product reach live Codex sessions only through the `codex` wrapper just installed in your shell profile. Restart your terminal, then start Codex as usual.";
  }

  const pathArgument = configPath ? ` --config-path ${configPath}` : "";

  return (
    "Organization and product reach live Codex sessions only through the `codex` wrapper. " +
    `Until it is installed, start Codex with \`${WRAPPER_COMMAND}${pathArgument} -- <args>\`.\n` +
    getManualInstructions(config)
  );
}

export async function setupAction(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Codex CLI Metering Setup\n"));

  enforceSetupFlags({
    apiKey: options.apiKey,
    email: options.email,
    endpoint: options.endpoint,
    organizationName: options.organizationName,
    productName: options.productName,
  });

  const existingToml = await readCodexToml(options.configPath);
  const otelEntries = existingToml == null ? [] : findOtelEntries(existingToml);

  if (otelEntries.length > 0 && !options.force) {
    const found = describeOtelEntries(otelEntries);

    if (!isInteractive()) {
      console.error(
        chalk.red(
          `Setup would remove the otel configuration already in your Codex config: ${found}.\n` +
            "Use --force to overwrite, or run in an interactive terminal to be prompted.",
        ),
      );
      process.exit(1);
      return;
    }

    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: `Setup would remove the otel configuration already in your Codex config: ${found}. Overwrite?`,
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log(chalk.yellow("Setup cancelled."));
      process.exit(0);
      return;
    }
  }

  const config = await collectConfig(options);

  if (!(await verifyEndpointAcceptsUsage(config))) {
    process.exit(1);
    return;
  }

  const block = generateTomlBlock(config);
  const { configPath, backupPath } = await writeCodexToml(block, options.configPath);

  if (backupPath) {
    console.log(chalk.green(`Backed up previous config to ${backupPath}`));
  }
  console.log(chalk.green(`Configuration written to ${configPath}`));

  const envPath = await writeReveniumEnv(config, options.configPath);
  console.log(chalk.green(`Environment file written to ${envPath}`));

  const profileUpdaterConfig = buildProfileUpdaterConfig(options.configPath);
  const wrapperInstalled = options.skipShellUpdate
    ? false
    : await installShellWrapper(profileUpdaterConfig);

  if (config.organizationName || config.productName) {
    console.log(
      chalk.gray(
        describeAttributionReach(wrapperInstalled, profileUpdaterConfig, options.configPath),
      ),
    );
  }

  if (config.logToolDetails === false) {
    console.log(
      chalk.gray(
        "Live export is off: Codex sends no events, so tool arguments and tool output stay on this machine. Your API key is stored in the environment file instead of config.toml, and `revenium-codex backfill` reads it from there to import usage.",
      ),
    );
  }

  if (config.email) {
    console.log(
      chalk.gray(
        `Note: ${config.email} attributes backfilled usage only. Live Codex sessions report their own signed-in identity (ChatGPT login) or no identity at all (API key) — the configured email does not apply there.`,
      ),
    );
  }

  console.log("\n" + chalk.green.bold("Setup complete!"));
}

async function collectConfig(options: SetupOptions): Promise<CodexOtelConfig> {
  const interactive = isInteractive();

  if (!interactive) {
    requireOptions([{ flag: "--api-key", value: options.apiKey }]);
  }

  const answers: Record<string, string> = interactive
    ? await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: "Enter your Revenium metering key rev_mk_... (recommended):",
          when: options.apiKey === undefined,
          validate: (input: string) => {
            const result = validateApiKey(input);
            return result.valid || result.errors.join(", ");
          },
          mask: "*",
        },
        {
          type: "input",
          name: "email",
          message:
            "Email for backfill attribution (optional) — live sessions report their own signed-in identity, or none under an API key:",
          when: options.email === undefined,
          validate: (input: string) => {
            const result = validateEmail(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "organizationName",
          message: "Organization name (for cost attribution, optional):",
          when: options.organizationName === undefined,
          validate: (input: string) => {
            const result = validateOrganizationName(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "productName",
          message: "Product name (for cost attribution, optional):",
          when: options.productName === undefined,
          validate: (input: string) => {
            const result = validateProductName(input.trim());
            return result.valid || result.errors.join(", ");
          },
        },
        {
          type: "input",
          name: "endpoint",
          message: "Revenium API endpoint:",
          default: DEFAULT_REVENIUM_URL,
          when: options.endpoint === undefined,
          validate: (input: string) => {
            const result = validateEndpointUrl(input);
            return result.valid || result.errors.join(", ");
          },
        },
      ])
    : {};

  const apiKey = options.apiKey ?? answers.apiKey;
  const email = firstNonEmpty(options.email, answers.email);
  const organizationName = firstNonEmpty(options.organizationName, answers.organizationName);
  const productName = firstNonEmpty(options.productName, answers.productName);
  const endpoint = options.endpoint ?? answers.endpoint;

  enforceSetupInputs({
    apiKey,
    email,
    endpoint: endpoint ?? DEFAULT_REVENIUM_URL,
    organizationName,
    productName,
  });

  return {
    apiKey,
    email,
    organizationName,
    productName,
    endpoint,
    logToolDetails: options.logToolDetails,
  };
}
