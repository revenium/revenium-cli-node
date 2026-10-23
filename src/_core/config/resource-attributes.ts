import { escapeResourceAttributeValue } from "../shell/escaping.js";

export interface ResourceAttributeValues {
  email?: string;
  organizationName?: string;
  productName?: string;
}

export const ATTRIBUTION_ATTRIBUTE_KEYS = {
  email: "user.email",
  organizationName: "organization.name",
  productName: "product.name",
} as const;

const ENCODED_ATTRIBUTION_KEYS = new Set<string>(Object.values(ATTRIBUTION_ATTRIBUTE_KEYS));

export function encodeAttributionValue(key: string, value: string): string {
  return ENCODED_ATTRIBUTION_KEYS.has(key) ? escapeResourceAttributeValue(value) : value;
}

export function buildResourceAttributes(values: ResourceAttributeValues): string {
  const entries: Array<[string, string | undefined]> = [
    [ATTRIBUTION_ATTRIBUTE_KEYS.email, values.email],
    [ATTRIBUTION_ATTRIBUTE_KEYS.organizationName, values.organizationName],
    [ATTRIBUTION_ATTRIBUTE_KEYS.productName, values.productName],
  ];

  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeAttributionValue(key, value)}`)
    .join(",");
}
