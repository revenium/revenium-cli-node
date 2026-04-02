/**
 * Getting Started with Revenium CLI - Gemini CLI
 *
 * This example demonstrates how to programmatically verify
 * your Gemini CLI metering setup is working.
 *
 * Prerequisites:
 * 1. Run: revenium-gemini setup
 * 2. Ensure ~/.gemini/revenium.env exists with valid config
 */

import 'dotenv/config';
import {
  validateApiKey,
  checkEndpointHealth,
  maskApiKey,
  detectShell,
  getProfilePath,
} from "@revenium/cli";

const API_KEY = process.env.REVENIUM_API_KEY!;
const ENDPOINT = process.env.REVENIUM_ENDPOINT || "https://api.revenium.ai";

async function main() {
  console.log("Revenium CLI - Gemini CLI Setup Verification\n");

  // 1. Validate API key format
  const keyResult = validateApiKey(API_KEY);
  console.log("API Key:", maskApiKey(API_KEY));
  console.log("Key valid:", keyResult.valid);

  if (!keyResult.valid) {
    console.error("Validation errors:", keyResult.errors);
    process.exit(1);
  }

  // 2. Detect shell environment
  const shell = detectShell();
  const profilePath = getProfilePath(shell);
  console.log("\nShell:", shell);
  console.log("Profile:", profilePath);

  // 3. Test endpoint connectivity
  console.log("\nTesting endpoint connectivity...");
  const health = await checkEndpointHealth(ENDPOINT, API_KEY, "gemini-cli");

  console.log("Healthy:", health.healthy);
  console.log("Latency:", health.latencyMs, "ms");
  console.log("Message:", health.message);

  if (health.healthy) {
    console.log("\nSetup verified! Gemini CLI metering is ready.");
  } else {
    console.error("\nSetup verification failed. Check your configuration.");
    process.exit(1);
  }
}

main().catch(console.error);
