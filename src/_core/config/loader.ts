import { OTLP_PATH } from "../constants.js";

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

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
        value = value.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
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

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
        value = value
          .replace(/'\\''/g, "'")
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\$/g, "$")
          .replace(/\\`/g, "`")
          .replace(/\\\\/g, "\\");
      }

      result[key] = value;
    }
  }

  return result;
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

export function extractBaseEndpoint(fullEndpoint: string): string {
  try {
    const url = new URL(fullEndpoint);
    const path = url.pathname;
    if (path.includes("/meter/v2/otlp") || path.includes("/meter/v2/ai/otlp")) {
      url.pathname = "";
    }
    return url.origin;
  } catch {
    return fullEndpoint;
  }
}

export function getFullOtlpEndpoint(baseUrl: string): string {
  const cleanUrl = baseUrl.replace(/\/$/, "");
  return `${cleanUrl}${OTLP_PATH}`;
}
