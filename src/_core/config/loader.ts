import { readFile } from "node:fs/promises";
import { OTLP_PATH, MGMT_API_PATH_SUFFIX } from "../constants.js";

export function parseEnvContent(content: string, isFish = false): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    let trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (isFish && trimmed.startsWith("set -gx ")) {
      trimmed = trimmed.substring(8).trim();
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) continue;

      const key = trimmed.substring(0, spaceIndex).trim();
      let value = trimmed.substring(spaceIndex + 1).trim();

      if (value.startsWith("'") && value.endsWith("'")) {
        value = value
          .substring(1, value.length - 1)
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\");
      } else if (value.startsWith('"') && value.endsWith('"')) {
        value = value
          .substring(1, value.length - 1)
          .replace(/\\"/g, '"')
          .replace(/\\\$/g, "$")
          .replace(/\\\\/g, "\\");
      }

      result[key] = value;
    } else {
      if (trimmed.startsWith("export ")) {
        trimmed = trimmed.substring(7).trim();
      }

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) {
        continue;
      }

      const key = trimmed.substring(0, equalsIndex).trim();
      let value = trimmed.substring(equalsIndex + 1).trim();

      if (value.startsWith("'") && value.endsWith("'")) {
        value = value.substring(1, value.length - 1).replace(/'\\''/g, "'");
      } else if (value.startsWith('"') && value.endsWith('"')) {
        value = value
          .substring(1, value.length - 1)
          .replace(/\\"/g, '"')
          .replace(/\\\$/g, "$")
          .replace(/\\`/g, "`")
          .replace(/\\\\/g, "\\");
      }

      result[key] = value;
    }
  }

  return result;
}

export function findUnknownKeys(content: string, knownKeys: readonly string[]): string[] {
  const known = new Set(knownKeys);
  return Object.keys(parseEnvContent(content))
    .filter((key) => !known.has(key))
    .sort((a, b) => a.localeCompare(b));
}

export async function readUnknownKeys(
  configPath: string,
  knownKeys: readonly string[],
): Promise<string[]> {
  try {
    return findUnknownKeys(await readFile(configPath, "utf-8"), knownKeys);
  } catch {
    return [];
  }
}

export function parseOtelResourceAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "string") return result;

  const pairs = value.split(",");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.substring(0, equalsIndex).trim();
    let attrValue = trimmed.substring(equalsIndex + 1).trim();

    try {
      attrValue = decodeURIComponent(attrValue);
    } catch {
      // use raw value
    }

    if (key) result[key] = attrValue;
  }
  return result;
}

const OTLP_SIGNAL_SUFFIX = /\/v1\/(?:logs|traces|metrics)\/*$/i;
const OTLP_REQUEST_SUFFIX =
  /\/meter(?:\/v2(?:\/ai)?(?:\/otlp(?:\/v1\/(?:logs|traces|metrics))?)?)?\/*$/i;
const OPAQUE_ORIGIN = "null";

export function extractBaseEndpoint(fullEndpoint: string): string {
  try {
    const url = new URL(fullEndpoint);
    if (url.origin === OPAQUE_ORIGIN) {
      return fullEndpoint;
    }
    const prefix = url.pathname.replace(OTLP_REQUEST_SUFFIX, "");
    return `${url.origin}${prefix}`.replace(/\/+$/, "");
  } catch {
    return fullEndpoint;
  }
}

// Codex stores the full OTLP request URL, including legacy variants that carry only the signal
// path, so a bare `/v1/logs` tail is a suffix there — unlike in a saved base, where it can be a
// gateway path prefix.
export function extractBaseFromOtlpRequestUrl(requestUrl: string): string {
  return extractBaseEndpoint(requestUrl.replace(OTLP_SIGNAL_SUFFIX, ""));
}

export function getFullOtlpEndpoint(baseUrl: string): string {
  const cleanUrl = baseUrl.replace(/\/$/, "");
  return `${cleanUrl}${OTLP_PATH}`;
}

// Management-plane API base (session attribution, etc.) — distinct from the OTLP ingest path.
// The input is the configured base endpoint, gateway path prefix included; an explicit override
// always wins, otherwise the default is `${otlpBaseEndpoint}/profitstream`.
export function getManagementEndpoint(otlpBaseEndpoint: string, override?: string): string {
  if (override && override.trim()) {
    return override.trim().replace(/\/+$/, "");
  }
  return `${otlpBaseEndpoint.replace(/\/+$/, "")}${MGMT_API_PATH_SUFFIX}`;
}
