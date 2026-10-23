import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  CODEX_CONFIG_DIR,
  CODEX_CONFIG_FILE,
  CODEX_ENV_KEYS,
  CODEX_SESSIONS_DIR_NAME,
} from "../constants.js";
import {
  extractBaseEndpoint,
  extractBaseFromOtlpRequestUrl,
  parseEnvContent,
} from "../../_core/config/loader.js";
import { DEFAULT_REVENIUM_URL, REVENIUM_ENV_FILE } from "../../_core/constants.js";
import { findOtelEntries } from "./otel-entries.js";
import { readTableBody, scanTomlLines } from "./toml-lines.js";

// A whitespace-only override is treated as unset: trusting it verbatim would resolve every Codex
// path under a directory named " " instead of falling back to ~/.codex.
export function getCodexHome(): string {
  return process.env[CODEX_ENV_KEYS.CODEX_HOME]?.trim() || join(homedir(), CODEX_CONFIG_DIR);
}

export function getCodexConfigPath(override?: string): string {
  if (override) return override;
  return join(getCodexHome(), CODEX_CONFIG_FILE);
}

export function getCodexSessionsPath(override?: string): string {
  if (override) return override;
  return join(getCodexHome(), CODEX_SESSIONS_DIR_NAME);
}

export function getReveniumEnvPath(configPathOverride?: string): string {
  if (configPathOverride) {
    return join(dirname(configPathOverride), REVENIUM_ENV_FILE);
  }
  return join(getCodexHome(), REVENIUM_ENV_FILE);
}

export function reveniumEnvExists(configPathOverride?: string): boolean {
  return existsSync(getReveniumEnvPath(configPathOverride));
}

export async function readReveniumEnv(configPath?: string): Promise<Record<string, string>> {
  const envPath = getReveniumEnvPath(configPath);
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvContent(await readFile(envPath, "utf-8"));
  } catch {
    return {};
  }
}

export function isLegacyFlatKeyForm(tomlText: string): boolean {
  return findOtelEntries(tomlText).some((entry) => entry.kind === "dotted-key");
}

export async function readCodexToml(configPath?: string): Promise<string | null> {
  const path = getCodexConfigPath(configPath);
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export function hasOtelSection(tomlText: string): boolean {
  return findOtelEntries(tomlText).some(
    (entry) =>
      entry.kind !== "dotted-key" &&
      (entry.name === "otel" || entry.name.startsWith("otel.exporter")),
  );
}

function extractSection(tomlText: string, sectionName: string): string | null {
  const body = readTableBody(scanTomlLines(tomlText), sectionName);
  return body === null ? null : body.join("\n");
}

export function hasFeaturesRuntimeMetrics(tomlText: string): boolean {
  const block = extractSection(tomlText, "features");
  if (block === null) return false;
  return /^\s*runtime_metrics\s*=\s*true\b/m.test(block);
}

export function hasDisabledExporter(tomlText: string): boolean {
  const otelBlock = extractSection(tomlText, "otel");
  if (otelBlock === null) return false;
  return /^\s*exporter\s*=\s*(?:"none"|'none')\s*(?:#.*)?$/m.test(otelBlock);
}

export function extractOtelValues(tomlText: string): { endpoint: string; apiKey: string } | null {
  const otelBlock = extractSection(tomlText, "otel");
  const legacyEndpoint = otelBlock ? /^\s*endpoint\s*=\s*"([^"]+)"/m.exec(otelBlock)?.[1] : null;
  const legacyApiKey = otelBlock ? /^\s*api_key\s*=\s*"([^"]+)"/m.exec(otelBlock)?.[1] : null;
  if (legacyEndpoint && legacyApiKey)
    return { endpoint: extractBaseFromOtlpRequestUrl(legacyEndpoint), apiKey: legacyApiKey };

  const inlineExporterLine = otelBlock
    ? /^\s*exporter\s*=.*otlp-http.*$/m.exec(otelBlock)?.[0]
    : null;
  if (inlineExporterLine) {
    const rawEndpoint = /endpoint\s*=\s*"([^"]+)"/.exec(inlineExporterLine)?.[1];
    const apiKey = /"?x-api-key"?\s*=\s*"([^"]+)"/.exec(inlineExporterLine)?.[1];
    if (rawEndpoint && apiKey) {
      return { endpoint: extractBaseFromOtlpRequestUrl(rawEndpoint), apiKey };
    }
  }

  const exporterBlock = extractSection(tomlText, "otel.exporter.otlp-http");
  const headersBlock = extractSection(tomlText, "otel.exporter.otlp-http.headers");
  if (!exporterBlock || !headersBlock) return null;

  const rawEndpoint = /^\s*endpoint\s*=\s*"([^"]+)"/m.exec(exporterBlock)?.[1];
  const apiKey = /^\s*"?x-api-key"?\s*=\s*"([^"]+)"/m.exec(headersBlock)?.[1];
  if (!rawEndpoint || !apiKey) return null;

  return { endpoint: extractBaseFromOtlpRequestUrl(rawEndpoint), apiKey };
}

export async function resolveOtelCredentials(
  tomlText: string | null,
  configPath?: string,
): Promise<{ endpoint: string; apiKey: string } | null> {
  const fromToml = tomlText ? extractOtelValues(tomlText) : null;
  if (fromToml) return fromToml;

  const env = await readReveniumEnv(configPath);
  const apiKey = env[CODEX_ENV_KEYS.REVENIUM_API_KEY];
  if (!apiKey) return null;

  return {
    endpoint: extractBaseEndpoint(env[CODEX_ENV_KEYS.REVENIUM_ENDPOINT] || DEFAULT_REVENIUM_URL),
    apiKey,
  };
}
