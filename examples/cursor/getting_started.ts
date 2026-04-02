/**
 * Getting Started with Revenium CLI - Cursor IDE
 *
 * This example demonstrates how to programmatically verify
 * your Cursor IDE metering setup is working.
 *
 * Prerequisites:
 * 1. Run: revenium-cursor setup
 * 2. Ensure ~/.cursor/revenium/revenium.env exists with valid config
 */

import 'dotenv/config';
import {
  validateApiKey,
  checkEndpointHealth,
  maskApiKey,
} from "@revenium/cli";

const API_KEY = process.env.REVENIUM_API_KEY!;
const ENDPOINT = process.env.REVENIUM_ENDPOINT || "https://api.revenium.ai";

async function main() {
  console.log("Revenium CLI - Cursor IDE Setup Verification\n");

  // 1. Validate API key format
  const keyResult = validateApiKey(API_KEY);
  console.log("API Key:", maskApiKey(API_KEY));
  console.log("Key valid:", keyResult.valid);

  if (!keyResult.valid) {
    console.error("Validation errors:", keyResult.errors);
    process.exit(1);
  }

  // 2. Test endpoint connectivity
  console.log("\nTesting endpoint connectivity...");
  const health = await checkEndpointHealth(ENDPOINT, API_KEY, "cursor-ide");

  console.log("Healthy:", health.healthy);
  console.log("Latency:", health.latencyMs, "ms");
  console.log("Message:", health.message);

  if (health.healthy) {
    console.log("\nSetup verified! Cursor IDE metering is ready.");
    console.log("Run 'revenium-cursor sync --watch' to start continuous sync.");
  } else {
    console.error("\nSetup verification failed. Check your configuration.");
    process.exit(1);
  }
}

main().catch(console.error);
