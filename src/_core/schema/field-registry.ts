export type OtlpFieldType = "stringValue" | "intValue" | "doubleValue" | "boolValue";

export type Platform = "claude-code" | "cursor" | "gemini" | "copilot";

export interface FieldDefinition {
  key: string;
  type: OtlpFieldType;
  scope: "log" | "resource";
  platforms: Platform[];
  required: boolean;
}

export const LOG_FIELDS: FieldDefinition[] = [
  {
    key: "model",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "input_tokens",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "output_tokens",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "cache_read_tokens",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "cache_creation_tokens",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "cost_usd",
    type: "stringValue",
    scope: "log",
    platforms: ["cursor", "gemini"],
    required: false,
  },
  {
    key: "duration_ms",
    type: "stringValue",
    scope: "log",
    platforms: ["gemini"],
    required: false,
  },
  {
    key: "session.id",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "gemini"],
    required: false,
  },
  {
    key: "transaction_id",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "copilot"],
    required: false,
  },
  {
    key: "user.email",
    type: "stringValue",
    scope: "log",
    platforms: ["claude-code", "cursor"],
    required: false,
  },
  {
    key: "billing.kind",
    type: "stringValue",
    scope: "log",
    platforms: ["cursor"],
    required: false,
  },
];

export const RESOURCE_FIELDS: FieldDefinition[] = [
  {
    key: "service.name",
    type: "stringValue",
    scope: "resource",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: true,
  },
  {
    key: "organization.name",
    type: "stringValue",
    scope: "resource",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: false,
  },
  {
    key: "product.name",
    type: "stringValue",
    scope: "resource",
    platforms: ["claude-code", "cursor", "gemini", "copilot"],
    required: false,
  },
  {
    key: "user.email",
    type: "stringValue",
    scope: "resource",
    platforms: ["cursor"],
    required: false,
  },
];

export const ALL_FIELDS: FieldDefinition[] = [...LOG_FIELDS, ...RESOURCE_FIELDS];

export function getFieldsForPlatform(
  platform: Platform,
  scope?: "log" | "resource",
): FieldDefinition[] {
  const fields = scope ? ALL_FIELDS.filter((f) => f.scope === scope) : ALL_FIELDS;
  return fields.filter((f) => f.platforms.includes(platform));
}

export function getRequiredFieldsForPlatform(
  platform: Platform,
  scope?: "log" | "resource",
): FieldDefinition[] {
  return getFieldsForPlatform(platform, scope).filter((f) => f.required);
}

export const SERVICE_NAMES: Record<Platform, string> = {
  "claude-code": "claude-code",
  cursor: "cursor-ide",
  gemini: "gemini-cli",
  copilot: "github-copilot-cli",
};

export const SCOPE_NAMES: Record<Platform, string> = {
  "claude-code": "claude-code",
  cursor: "cursor_admin_api",
  gemini: "gemini-cli",
  copilot: "github_copilot.log_only",
};

export const LOG_BODY_VALUES: Record<Platform, string> = {
  "claude-code": "claude_code.api_request",
  cursor: "cursor_ide.api_response",
  gemini: "gemini-cli.api_request",
  copilot: "chat",
};
