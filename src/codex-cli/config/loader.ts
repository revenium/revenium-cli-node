import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CODEX_CONFIG_DIR, CODEX_CONFIG_FILE } from "../constants.js";
import { extractBaseEndpoint } from "../../_core/config/loader.js";

export function getCodexConfigPath(override?: string): string {
  if (override) return override;
  return join(homedir(), CODEX_CONFIG_DIR, CODEX_CONFIG_FILE);
}

export function isLegacyFlatKeyForm(tomlText: string): boolean {
  return /^\s*otel\.[a-z_]/m.test(tomlText);
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
  return /^\[otel\]/m.test(tomlText) || /^\[otel\.exporter/m.test(tomlText);
}

function extractSection(tomlText: string, sectionName: string): string | null {
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^\\[${escapedName}\\]\\s*$`, "m");
  const headerMatch = headerRe.exec(tomlText);
  if (!headerMatch) return null;
  const start = headerMatch.index + headerMatch[0].length;
  const rest = tomlText.slice(start);
  const nextSection = rest.search(/^\[/m);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

export function hasFeaturesRuntimeMetrics(tomlText: string): boolean {
  const block = extractSection(tomlText, "features");
  if (block === null) return false;
  return /^\s*runtime_metrics\s*=\s*true\b/m.test(block);
}

export function extractOtelValues(tomlText: string): { endpoint: string; apiKey: string } | null {
  const otelBlock = extractSection(tomlText, "otel");
  const legacyEndpoint = otelBlock ? /^\s*endpoint\s*=\s*"([^"]+)"/m.exec(otelBlock)?.[1] : null;
  const legacyApiKey = otelBlock ? /^\s*api_key\s*=\s*"([^"]+)"/m.exec(otelBlock)?.[1] : null;
  if (legacyEndpoint && legacyApiKey) return { endpoint: legacyEndpoint, apiKey: legacyApiKey };

  const inlineExporterLine = otelBlock
    ? /^\s*exporter\s*=.*otlp-http.*$/m.exec(otelBlock)?.[0]
    : null;
  if (inlineExporterLine) {
    const rawEndpoint = /endpoint\s*=\s*"([^"]+)"/.exec(inlineExporterLine)?.[1];
    const apiKey = /"?x-api-key"?\s*=\s*"([^"]+)"/.exec(inlineExporterLine)?.[1];
    if (rawEndpoint && apiKey) {
      return { endpoint: extractBaseEndpoint(rawEndpoint), apiKey };
    }
  }

  const exporterBlock = extractSection(tomlText, "otel.exporter.otlp-http");
  const headersBlock = extractSection(tomlText, "otel.exporter.otlp-http.headers");
  if (!exporterBlock || !headersBlock) return null;

  const rawEndpoint = /^\s*endpoint\s*=\s*"([^"]+)"/m.exec(exporterBlock)?.[1];
  const apiKey = /^\s*"?x-api-key"?\s*=\s*"([^"]+)"/m.exec(headersBlock)?.[1];
  if (!rawEndpoint || !apiKey) return null;

  const endpoint = rawEndpoint.replace(/\/v1\/logs\/?$/, "");

  return { endpoint, apiKey };
}
