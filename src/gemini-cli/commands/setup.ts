import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { maskApiKey, maskEmail } from "../../_core/utils/masking.js";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  validateOrganizationName,
  validateProductName,
} from "../../_core/config/validator.js";
import { enforceSetupFlags, enforceSetupInputs } from "../../_core/config/setup-input-gate.js";
import { firstNonEmpty } from "../../_core/utils/optional-text.js";
import { extractBaseEndpoint } from "../../_core/config/loader.js";
import { checkEndpointHealth } from "../../_core/api/health-check.js";
import { isInteractive, requireOptions } from "../../_core/ui/interactive.js";
import { LOG_BODY_VALUES, SCOPE_NAMES } from "../../_core/schema/field-registry.js";
import { updateShellProfile, getManualInstructions } from "../../_core/shell/profile-updater.js";
import { writeConfig, getConfigFilePath } from "../config/writer.js";
import { getWrapperFunction, WRAPPER_LAUNCH_COMMAND } from "../shell/wrapper.js";
import { SHELL_PROFILE_MARKER } from "../constants.js";
import type { GeminiCliConfig } from "../config/loader.js";

interface SetupOptions {
  apiKey?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  endpoint?: string;
  skipShellUpdate?: boolean;
}

const profileUpdaterConfig = {
  markerName: SHELL_PROFILE_MARKER,
  getSourceCommand: getWrapperFunction,
  getConfigFilePath,
  pruneOtherProfiles: true,
};

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Gemini CLI Metering Setup\n"));

  const config = await collectConfiguration(options);

  const spinner = ora("Testing API key...").start();

  try {
    const healthResult = await checkEndpointHealth(config.endpoint, config.apiKey, "gemini-cli", {
      scopeName: SCOPE_NAMES["gemini"],
      bodyValue: LOG_BODY_VALUES["gemini"],
    });

    if (!healthResult.healthy) {
      spinner.fail(`API key validation failed: ${healthResult.message}`);
      process.exit(1);
    }

    if (!healthResult.processedEvents) {
      spinner.fail("API key validation failed: the endpoint processed no events");
      process.exit(1);
    }

    spinner.succeed(`API key validated (${healthResult.latencyMs}ms latency)`);
  } catch (error) {
    spinner.fail("Failed to validate API key");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const writeSpinner = ora("Writing configuration...").start();

  try {
    const envPath = await writeConfig(config);
    writeSpinner.succeed(`Configuration written to ${chalk.cyan(envPath)}`);
  } catch (error) {
    writeSpinner.fail("Failed to write configuration");
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  const wrapperInstalled = options.skipShellUpdate ? false : await installShellWrapper();

  printSuccessMessage(config, wrapperInstalled);
}

async function installShellWrapper(): Promise<boolean> {
  const shellSpinner = ora("Updating shell profile...").start();

  try {
    const shellResult = await updateShellProfile(profileUpdaterConfig);

    if (shellResult.success) {
      shellSpinner.succeed(shellResult.message);
      return true;
    }

    shellSpinner.warn(shellResult.message);
  } catch {
    shellSpinner.warn("Could not update shell profile automatically");
  }

  return false;
}

async function collectConfiguration(options: SetupOptions): Promise<GeminiCliConfig> {
  const interactive = isInteractive();

  if (!interactive) {
    requireOptions([{ flag: "--api-key", value: options.apiKey }]);
  }

  enforceSetupFlags({
    apiKey: options.apiKey,
    email: options.email,
    endpoint: options.endpoint,
    organizationName: options.organizationName,
    productName: options.productName,
  });

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
          message: "Enter your email (for usage attribution, optional):",
          when: options.email === undefined,
          validate: (input: string) => {
            if (!input) return true;
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

  const rawEndpoint = options.endpoint || answers.endpoint || DEFAULT_REVENIUM_URL;
  const endpoint = extractBaseEndpoint(rawEndpoint);
  const apiKey = options.apiKey ?? answers.apiKey;
  const email = firstNonEmpty(options.email, answers.email);
  const organizationName = firstNonEmpty(options.organizationName, answers.organizationName);
  const productName = firstNonEmpty(options.productName, answers.productName);

  enforceSetupInputs({ apiKey, email, endpoint: rawEndpoint, organizationName, productName });

  return {
    apiKey,
    email,
    organizationName,
    productName,
    endpoint,
  };
}

function printSuccessMessage(config: GeminiCliConfig, wrapperInstalled: boolean): void {
  console.log("\n" + chalk.green.bold("Setup complete!") + "\n");

  console.log(chalk.bold("Configuration:"));
  console.log(`  API Key:    ${maskApiKey(config.apiKey)}`);
  console.log(`  Endpoint:   ${config.endpoint}`);
  if (config.email) {
    console.log(`  Email:      ${maskEmail(config.email)}`);
  }
  if (config.organizationName) {
    console.log(`  Organization: ${config.organizationName}`);
  }
  if (config.productName) {
    console.log(`  Product:    ${config.productName}`);
  }

  console.log("\n" + chalk.yellow.bold("Next steps:"));

  if (wrapperInstalled) {
    console.log("  1. Restart your terminal so the `gemini` wrapper becomes available");
    console.log("  2. Start using Gemini CLI - telemetry will be sent automatically");
  } else {
    console.log(`  1. Start Gemini CLI with \`${WRAPPER_LAUNCH_COMMAND} <args>\``);
    console.log(
      `  2. Plain \`gemini\` sends no telemetry until the wrapper is installed:\n${chalk.dim(getManualInstructions(profileUpdaterConfig))}`,
    );
  }

  console.log("  3. Check your usage at https://app.revenium.ai");
}
