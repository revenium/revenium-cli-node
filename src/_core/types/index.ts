export interface ReveniumCliConfig {
  apiKey: string;
  endpoint: string;
  email?: string;
  organizationName?: string;
  productName?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface HealthCheckResult {
  healthy: boolean;
  statusCode?: number;
  message: string;
  latencyMs?: number;
}

export type ShellType = "bash" | "zsh" | "fish" | "unknown";

export interface ShellUpdateResult {
  success: boolean;
  shellType: ShellType;
  profilePath?: string;
  message: string;
}

export interface OTLPValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OTLPLogsPayload {
  resourceLogs: Array<{
    resource?: {
      attributes?: Array<{
        key: string;
        value: OTLPValue;
      }>;
    };
    scopeLogs: Array<{
      scope?: {
        name: string;
        version: string;
      };
      logRecords: Array<{
        timeUnixNano?: string;
        body: OTLPValue;
        attributes: Array<{
          key: string;
          value: OTLPValue;
        }>;
      }>;
    }>;
  }>;
}

export interface OTLPResponse {
  id: string;
  resourceType: string;
  processedEvents: number;
  created: string;
}

export interface ToolContext {
  sessionId?: string;
  userId?: string;
  organizationName?: string;
  productName?: string;
  apiKey?: string;
  endpoint?: string;
}

export interface ToolMetadata {
  description?: string;
  category?: string;
  version?: string;
  tags?: string[];
  outputFields?: string[];
  usageMetadata?: Record<string, unknown>;
}

export interface ToolEventPayload {
  toolId: string;
  sessionId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  metadata?: ToolMetadata;
  userId?: string;
  organizationName?: string;
  productName?: string;
}

export interface ToolCallReport {
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  metadata?: ToolMetadata;
}
