import 'dotenv/config';
import { checkEndpointHealth, generateTestSessionId, createTestPayload } from "@revenium/cli";

const API_KEY = process.env.REVENIUM_API_KEY!;
const ENDPOINT = process.env.REVENIUM_ENDPOINT || "https://api.revenium.ai";

async function main() {
  console.log("Checking endpoint health...\n");

  const result = await checkEndpointHealth(ENDPOINT, API_KEY, "health-check-example", {
    email: "test@example.com",
    organizationName: "my-org",
    productName: "my-product",
  });

  console.log("Healthy:", result.healthy);
  console.log("Status:", result.statusCode);
  console.log("Message:", result.message);
  console.log("Latency:", result.latencyMs, "ms");

  console.log("\n--- Test Payload Preview ---\n");

  const sessionId = generateTestSessionId();
  const payload = createTestPayload(sessionId, "claude-code");
  console.log(JSON.stringify(payload, null, 2));
}

main().catch(console.error);
