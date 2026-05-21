import { randomBytes } from "node:crypto";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, configExists } from "../config/loader.js";
import { sendOtlpTraces } from "../../_core/api/otlp-client.js";
import type { OTLPTracesPayload } from "../../_core/types/index.js";
import { SERVICE_NAME, SCOPE_NAME } from "../constants.js";

interface TestOptions {
  verbose?: boolean;
}

function createTestTracesPayload(
  serviceName: string,
  options?: { email?: string; organizationName?: string; productName?: string },
): OTLPTracesPayload {
  const now = BigInt(Date.now()) * 1_000_000n;
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");

  const attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }> = [
    { key: "gen_ai.request.model", value: { stringValue: "cli-connectivity-test" } },
    { key: "gen_ai.system", value: { stringValue: "github" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: 0 } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: 0 } },
    { key: "gen_ai.conversation.id", value: { stringValue: `test-${traceId.substring(0, 12)}` } },
    { key: "gen_ai.response.finish_reasons", value: { stringValue: "stop" } },
  ];

  if (options?.email) {
    attributes.push({ key: "user.email", value: { stringValue: options.email } });
  }
  if (options?.organizationName) {
    attributes.push({ key: "organization.name", value: { stringValue: options.organizationName } });
  }
  if (options?.productName) {
    attributes.push({ key: "product.name", value: { stringValue: options.productName } });
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: "1.0.0" },
            spans: [
              {
                traceId,
                spanId,
                name: "chat",
                kind: 3,
                startTimeUnixNano: now.toString(),
                endTimeUnixNano: now.toString(),
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function testCommand(options: TestOptions = {}): Promise<void> {
  console.log(chalk.bold("\nRevenium GitHub Copilot Metering Test\n"));

  if (!configExists()) {
    console.log(chalk.red("Configuration not found"));
    console.log(chalk.yellow("Run `revenium-copilot setup` first to configure the integration."));
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("Could not load configuration"));
    process.exit(1);
  }

  const payload = createTestTracesPayload(SERVICE_NAME, {
    email: config.email,
    organizationName: config.organizationName,
    productName: config.productName,
  });

  if (options.verbose) {
    console.log(chalk.dim("Test payload:"));
    console.log(chalk.dim(JSON.stringify(payload, null, 2)));
    console.log("");
  }

  const spinner = ora("Sending test metric...").start();

  try {
    const startTime = Date.now();
    const response = await sendOtlpTraces(config.reveniumEndpoint, config.reveniumApiKey, payload);
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
    console.log(
      chalk.dim("You can verify it in the Revenium dashboard at https://app.revenium.ai"),
    );
  } catch (error) {
    spinner.fail("Failed to send test metric");
    console.error(
      chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`),
    );

    console.log("\n" + chalk.yellow("Troubleshooting:"));
    console.log("  1. Verify your Revenium API key is correct");
    console.log("  2. Check the endpoint URL");
    console.log("  3. Ensure you have network connectivity");
    console.log("  4. Run `revenium-copilot status` for more details");

    process.exit(1);
  }

  console.log("");
}
