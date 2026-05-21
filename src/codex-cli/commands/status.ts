import chalk from "chalk";
import {
  readCodexToml,
  isLegacyFlatKeyForm,
  hasOtelSection,
  hasFeaturesRuntimeMetrics,
  extractOtelValues,
  getCodexConfigPath,
} from "../config/loader.js";
import { generateTestSessionId } from "../../_core/api/health-check.js";
import { sendOtlpLogs } from "../../_core/api/otlp-client.js";
import { createCodexMapperTestPayload } from "../payloads/test-payload.js";

interface StatusOptions {
  configPath?: string;
}

export async function statusAction(options: StatusOptions = {}): Promise<void> {
  const configPath = getCodexConfigPath(options.configPath);
  const toml = await readCodexToml(options.configPath);

  if (!toml) {
    console.log(chalk.red("No Codex config found."));
    console.log(chalk.dim(`Expected at: ${configPath}`));
    console.log(chalk.yellow("\nRun `revenium-codex setup` to configure Codex otel metering."));
    process.exit(1);
    return;
  }

  if (isLegacyFlatKeyForm(toml)) {
    console.error(
      chalk.red(
        "Config uses legacy flat-key [otel] form — this silent-drop footgun means your " +
          "otel settings are silently ignored by Codex. Run `revenium-codex setup --force` to migrate.",
      ),
    );
    process.exit(1);
    return;
  }

  if (!hasOtelSection(toml)) {
    console.log(
      chalk.yellow("Codex otel config not found. Run `revenium-codex setup` to configure."),
    );
    process.exit(1);
    return;
  }

  console.log(chalk.green("Codex otel config is present and uses struct-variant [otel] form."));

  if (!hasFeaturesRuntimeMetrics(toml)) {
    console.error(
      chalk.red(
        "Config is missing [features] runtime_metrics = true — Codex will not emit OTEL data " +
          "without it (per d2 S2.1). Run `revenium-codex setup --force` to fix.",
      ),
    );
    process.exit(1);
    return;
  }

  console.log(chalk.green("[features] runtime_metrics = true is set."));

  const otelValues = extractOtelValues(toml);
  if (!otelValues) {
    console.log(
      chalk.yellow(
        "Could not extract endpoint and api_key from [otel] block — skipping connection check.",
      ),
    );
    return;
  }

  console.log(chalk.bold("\nConnection check:"));
  try {
    const startTime = Date.now();
    await sendOtlpLogs(
      otelValues.endpoint,
      otelValues.apiKey,
      createCodexMapperTestPayload(generateTestSessionId()),
    );
    console.log(chalk.green(`  Endpoint healthy (${Date.now() - startTime}ms)`));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.log(chalk.yellow(`  Connection check failed: ${msg}`));
  }
}
