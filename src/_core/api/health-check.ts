import type { OTLPLogsPayload, OTLPResponse, HealthCheckResult } from "../types/index.js";
import { REVENIUM_API_KEY_ATTR } from "../constants.js";
import { sendOtlpLogs } from "./otlp-client.js";

export interface TestPayloadOptions {
  email?: string;
  organizationName?: string;
  productName?: string;
  bodyValue?: string;
  scopeName?: string;
}

export function generateTestSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `test-${timestamp}-${random}`;
}

export function createTestPayload(
  sessionId: string,
  serviceName: string,
  options?: TestPayloadOptions,
): OTLPLogsPayload {
  const now = Date.now() * 1_000_000;

  const logAttributes: Array<{
    key: string;
    value: { stringValue: string };
  }> = [
    { key: "session.id", value: { stringValue: sessionId } },
    { key: "model", value: { stringValue: "cli-connectivity-test" } },
    { key: "input_tokens", value: { stringValue: "0" } },
    { key: "output_tokens", value: { stringValue: "0" } },
    { key: "cache_read_tokens", value: { stringValue: "0" } },
    { key: "cache_creation_tokens", value: { stringValue: "0" } },
    { key: "cost_usd", value: { stringValue: "0.0" } },
    { key: "duration_ms", value: { stringValue: "0" } },
  ];

  // Email: use options, then fallback to env
  const email = options?.email || process.env.REVENIUM_SUBSCRIBER_EMAIL;
  if (email) {
    logAttributes.push({
      key: "user.email",
      value: { stringValue: email },
    });
  }

  const resourceAttributes: Array<{
    key: string;
    value: { stringValue: string };
  }> = [{ key: "service.name", value: { stringValue: serviceName } }];

  // org/product in resource attributes
  if (options?.organizationName) {
    resourceAttributes.push({
      key: "organization.name",
      value: { stringValue: options.organizationName },
    });
  }

  if (options?.productName) {
    resourceAttributes.push({
      key: "product.name",
      value: { stringValue: options.productName },
    });
  }

  // Parse existing OTEL_RESOURCE_ATTRIBUTES from env
  const envResourceAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (envResourceAttrs) {
    const excludeKeys = new Set(["service.name", "user.email", REVENIUM_API_KEY_ATTR]);
    for (const pair of envResourceAttrs.split(",")) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;
      const key = pair.substring(0, eqIndex).trim();
      if (!key || excludeKeys.has(key)) continue;
      // Skip if already added via options
      if (resourceAttributes.some((a) => a.key === key)) continue;
      let value = pair.substring(eqIndex + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        // use raw value if percent-encoding is malformed
      }
      resourceAttributes.push({ key, value: { stringValue: value } });
    }
  }

  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes,
        },
        scopeLogs: [
          {
            scope: {
              name: options?.scopeName ?? serviceName,
              version: "1.0.0",
            },
            logRecords: [
              {
                timeUnixNano: now.toString(),
                body: { stringValue: options?.bodyValue ?? `${serviceName}.api_request` },
                attributes: logAttributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function sendTestDelivery(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
  isAccepted: (response: OTLPResponse) => boolean,
): Promise<HealthCheckResult> {
  const startTime = Date.now();

  try {
    const response = await sendOtlpLogs(baseEndpoint, apiKey, payload);
    const latencyMs = Date.now() - startTime;
    const accepted = isAccepted(response);

    return {
      healthy: accepted,
      statusCode: 200,
      message: accepted
        ? `Endpoint healthy. Processed ${response.processedEvents} event(s).`
        : `The endpoint returned success but did not accept the usage: ${response.processedEvents} event(s) processed, ${response.failedEvents ?? 0} rejected. Check that the API key is recognized by this endpoint.`,
      latencyMs,
      processedEvents: response.processedEvents,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusMatch = message.match(/OTLP request failed: (\d{3})/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

    return {
      healthy: false,
      statusCode,
      message,
      latencyMs,
    };
  }
}

export async function checkPayloadDelivery(
  baseEndpoint: string,
  apiKey: string,
  payload: OTLPLogsPayload,
): Promise<HealthCheckResult> {
  return sendTestDelivery(
    baseEndpoint,
    apiKey,
    payload,
    (response) => response.processedEvents > 0 && (response.failedEvents ?? 0) === 0,
  );
}

export async function checkEndpointHealth(
  baseEndpoint: string,
  apiKey: string,
  serviceName: string,
  options?: TestPayloadOptions,
): Promise<HealthCheckResult> {
  return sendTestDelivery(
    baseEndpoint,
    apiKey,
    createTestPayload(generateTestSessionId(), serviceName, options),
    () => true,
  );
}
