import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists } from "../config/loader.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { createTestPayload, generateTestSessionId } from "../../_core/api/health-check.js";
import { LOG_BODY_VALUES, SCOPE_NAMES } from "../../_core/schema/field-registry.js";

interface TestOptions {
  verbose?: boolean;
}

export async function testCommand(options: TestOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium Gemini CLI Metering Test\n"));

  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-gemini setup` first to configure the integration."));
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  const sessionId = generateTestSessionId();
  const payload = createTestPayload(sessionId, "gemini-cli", {
    email: config.email,
    organizationName: config.organizationName,
    productName: config.productName,
    bodyValue: LOG_BODY_VALUES["gemini"],
    scopeName: SCOPE_NAMES["gemini"],
  });

  if (options.verbose) {
    console.log(chalk.dim("Test payload:"));
    console.log(chalk.dim(JSON.stringify(payload, null, 2)));
    console.log("");
  }

  const spinner = ora("Sending test metric...").start();

  try {
    const startTime = Date.now();
    const response = await sendOtlpLogs(config.endpoint, config.apiKey, payload);
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
    console.log(chalk.dim("\nNote: This test metric uses session ID: " + sessionId));
  } catch (error) {
    spinner.fail("Failed to send test metric");
    console.error(
      chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`),
    );

    console.log("\n" + chalk.yellow("Troubleshooting:"));
    console.log("  1. Verify your API key is correct");
    console.log("  2. Check the endpoint URL");
    console.log("  3. Ensure you have network connectivity");
    console.log("  4. Run `revenium-gemini status` for more details");

    process.exit(1);
  }

  console.log("");
}
