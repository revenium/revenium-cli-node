import inquirer from "inquirer";
import chalk from "chalk";
import { DEFAULT_REVENIUM_URL } from "../../_core/constants.js";
import { validateApiKey } from "../../_core/config/validator.js";
import { updateShellProfile } from "../../_core/shell/profile-updater.js";
import { escapeShellValue } from "../../_core/shell/escaping.js";
import { readCodexToml, hasOtelSection } from "../config/loader.js";
import {
  generateTomlBlock,
  writeCodexToml,
  writeReveniumEnv,
  getReveniumEnvPath,
} from "../config/writer.js";
import type { CodexOtelConfig } from "../config/writer.js";

interface SetupOptions {
  apiKey?: string;
  email?: string;
  organizationName?: string;
  productName?: string;
  endpoint?: string;
  configPath?: string;
  skipShellUpdate?: boolean;
  force?: boolean;
}

export async function setupAction(options: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Codex CLI Metering Setup\n"));

  const existingToml = await readCodexToml(options.configPath);
  const hasOtel = existingToml != null && hasOtelSection(existingToml);

  if (hasOtel && !options.force) {
    if (!process.stdout.isTTY) {
      console.error(
        chalk.red(
          "Codex otel config already exists. Use --force to overwrite, or run in an interactive terminal to be prompted.",
        ),
      );
      process.exit(1);
      return;
    }

    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: "Codex otel config already exists. Overwrite?",
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
  const block = generateTomlBlock(config);
  const configPath = await writeCodexToml(block, options.configPath);

  console.log(chalk.green(`Configuration written to ${configPath}`));

  const envPath = await writeReveniumEnv(config, options.configPath);
  console.log(chalk.green(`Environment file written to ${envPath}`));

  if (!options.skipShellUpdate) {
    try {
      const result = await updateShellProfile({
        markerName: "revenium-codex-metering",
        getSourceCommand: (_shellType, filePath) => {
          const escaped = escapeShellValue(filePath);
          return `if [ -f ${escaped} ]; then\n    source ${escaped}\nfi`;
        },
        getConfigFilePath: () => getReveniumEnvPath(options.configPath),
      });

      if (result.success) {
        console.log(chalk.green(result.message));
      } else {
        console.log(chalk.yellow(result.message));
      }
    } catch {
      console.log(chalk.yellow("Could not update shell profile automatically."));
    }
  }

  console.log("\n" + chalk.green.bold("Setup complete!"));
}

async function collectConfig(options: SetupOptions): Promise<CodexOtelConfig> {
  if (options.apiKey) {
    const result = validateApiKey(options.apiKey);
    if (!result.valid) throw new Error(`Invalid API key: ${result.errors.join(", ")}`);
  }
  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: "Enter your Revenium API key (hak_... or rev_...):",
      when: !options.apiKey,
      validate: (input: string) => {
        const result = validateApiKey(input);
        return result.valid || result.errors.join(", ");
      },
      mask: "*",
    },
    {
      type: "input",
      name: "email",
      message: "Email for usage attribution (optional):",
      when: !options.email,
    },
    {
      type: "input",
      name: "organizationName",
      message: "Organization name (for cost attribution, optional):",
      when: !options.organizationName,
    },
    {
      type: "input",
      name: "productName",
      message: "Product name (for cost attribution, optional):",
      when: !options.productName,
    },
    {
      type: "input",
      name: "endpoint",
      message: "Revenium API endpoint:",
      default: DEFAULT_REVENIUM_URL,
      when: !options.endpoint,
    },
  ]);

  return {
    apiKey: options.apiKey ?? (answers.apiKey as string),
    email: options.email ?? (answers.email as string | undefined) ?? undefined,
    organizationName:
      options.organizationName ?? (answers.organizationName as string | undefined) ?? undefined,
    productName: options.productName ?? (answers.productName as string | undefined) ?? undefined,
    endpoint: options.endpoint ?? (answers.endpoint as string) ?? DEFAULT_REVENIUM_URL,
  };
}
