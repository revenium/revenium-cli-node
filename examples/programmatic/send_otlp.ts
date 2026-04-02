import 'dotenv/config';
import { sendOtlpLogs, createTestPayload, generateTestSessionId } from "@revenium/cli";

const API_KEY = process.env.REVENIUM_API_KEY!;
const ENDPOINT = process.env.REVENIUM_ENDPOINT || "https://api.revenium.ai";

async function main() {
  const sessionId = generateTestSessionId();
  const payload = createTestPayload(sessionId, "claude-code", {
    email: "developer@example.com",
    organizationName: "my-org",
    productName: "my-product",
  });

  console.log("Sending OTLP test payload...");
  console.log("Session ID:", sessionId);

  const response = await sendOtlpLogs(ENDPOINT, API_KEY, payload);

  console.log("\nResponse:");
  console.log("  ID:", response.id);
  console.log("  Resource Type:", response.resourceType);
  console.log("  Processed Events:", response.processedEvents);
  console.log("  Created:", response.created);
}

main().catch(console.error);
