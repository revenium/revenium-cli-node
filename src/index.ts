export type {
  ReveniumCliConfig,
  ValidationResult,
  HealthCheckResult,
  ShellType,
  ShellUpdateResult,
  OTLPValue,
  OTLPLogsPayload,
  OTLPResponse,
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "./_core/types/index.js";

export { validateApiKey, validateEmail, validateEndpointUrl } from "./_core/config/validator.js";
export { sendOtlpLogs } from "./_core/api/otlp-client.js";
export {
  checkEndpointHealth,
  createTestPayload,
  generateTestSessionId,
} from "./_core/api/health-check.js";
export { maskApiKey, maskEmail } from "./_core/utils/masking.js";
export { detectShell, getProfilePath } from "./_core/shell/detector.js";
