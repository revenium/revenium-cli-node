import chalk from "chalk";
import ora from "ora";
import { readCodexToml, extractOtelValues, getCodexConfigPath } from "../config/loader.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { generateTestSessionId } from "../../_core/api/health-check.js";
import { createCodexMapperTestPayload } from "../payloads/test-payload.js";

interface TestOptions {
  verbose?: boolean;
  configPath?: string;
}

export async function testAction(options: TestOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Codex CLI Metering Test\n"));

  const toml = await readCodexToml(options.configPath);
  if (!toml) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.dim(`Expected at: ${getCodexConfigPath(options.configPath)}`));
    console.log(chalk.yellow("Run `revenium-codex setup` first to configure the integration."));
    process.exit(1);
    return;
  }

  const otelValues = extractOtelValues(toml);
  if (!otelValues) {
    console.log(chalk.red("Could not parse [otel] block from Codex config"));
    process.exit(1);
    return;
  }

  const sessionId = generateTestSessionId();
  const payload = createCodexMapperTestPayload(sessionId);

  if (options.verbose) {
    console.log(chalk.dim("Test payload:"));
    console.log(chalk.dim(JSON.stringify(payload, null, 2)));
    console.log("");
  }

  const spinner = ora("Sending test metric...").start();

  try {
    const startTime = Date.now();
    const response = await sendOtlpLogs(otelValues.endpoint, otelValues.apiKey, payload);
    const latencyMs = Date.now() - startTime;

    spinner.succeed(`Test metric sent successfully (${latencyMs}ms)`);

    console.log("\n" + chalk.bold("Response:"));
    console.log(`  ID:              ${response.id}`);
    console.log(`  Resource Type:   ${response.resourceType}`);
    console.log(`  Processed:       ${response.processedEvents} event(s)`);
    console.log(`  Created:         ${response.created}`);

    if (response.processedEvents > 0) {
      console.log("\n" + chalk.green.bold("Integration is working correctly!"));
    } else {
      console.log("\n" + chalk.yellow.bold("Metric was sent but not processed by the backend."));
      console.log(
        chalk.yellow("The backend returned processedEvents = 0. Check your mapper configuration."),
      );
    }
  } catch (error) {
    spinner.fail("Failed to send test metric");
    console.error(
      chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`),
    );

    console.log("\n" + chalk.yellow("Troubleshooting:"));
    console.log("  1. Verify your API key is correct");
    console.log("  2. Check the endpoint URL");
    console.log("  3. Ensure you have network connectivity");
    console.log("  4. Run `revenium-codex status` for more details");

    process.exit(1);
    return;
  }

  console.log("");
}
