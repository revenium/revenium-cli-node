import type { OTLPLogsPayload } from "../../src/_core/types/index.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateOtlpPayloadStructure(payload: OTLPLogsPayload): ValidationResult {
  const errors: string[] = [];

  if (!payload.resourceLogs || !Array.isArray(payload.resourceLogs)) {
    errors.push("Missing or invalid resourceLogs array");
    return { valid: false, errors };
  }

  if (payload.resourceLogs.length === 0) {
    errors.push("resourceLogs is empty");
    return { valid: false, errors };
  }

  for (let i = 0; i < payload.resourceLogs.length; i++) {
    const rl = payload.resourceLogs[i];

    if (!rl.scopeLogs || !Array.isArray(rl.scopeLogs)) {
      errors.push(`resourceLogs[${i}]: missing or invalid scopeLogs array`);
      continue;
    }

    if (rl.scopeLogs.length === 0) {
      errors.push(`resourceLogs[${i}]: scopeLogs is empty`);
      continue;
    }

    for (let j = 0; j < rl.scopeLogs.length; j++) {
      const sl = rl.scopeLogs[j];

      if (!sl.logRecords || !Array.isArray(sl.logRecords)) {
        errors.push(`resourceLogs[${i}].scopeLogs[${j}]: missing or invalid logRecords array`);
        continue;
      }

      if (sl.logRecords.length === 0) {
        errors.push(`resourceLogs[${i}].scopeLogs[${j}]: logRecords is empty`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateLogRecordAttributes(
  attributes: Array<{ key: string; value: { stringValue?: string } }>,
  requiredKeys: readonly string[],
): ValidationResult {
  const errors: string[] = [];
  const presentKeys = new Set(attributes.map((a) => a.key));

  for (const key of requiredKeys) {
    if (!presentKeys.has(key)) {
      errors.push(`Missing required attribute: ${key}`);
      continue;
    }

    const attr = attributes.find((a) => a.key === key);
    if (attr && attr.value.stringValue === undefined) {
      errors.push(`Attribute ${key} has no stringValue`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateResourceAttributes(
  attributes: Array<{ key: string; value: { stringValue?: string } }>,
  expectedServiceName: string,
): ValidationResult {
  const errors: string[] = [];

  const serviceName = attributes.find((a) => a.key === "service.name");
  if (!serviceName) {
    errors.push("Missing service.name in resource attributes");
  } else if (serviceName.value.stringValue !== expectedServiceName) {
    errors.push(
      `Expected service.name "${expectedServiceName}", got "${serviceName.value.stringValue}"`,
    );
  }

  return { valid: errors.length === 0, errors };
}
