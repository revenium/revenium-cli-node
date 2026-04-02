import 'dotenv/config';
import { verifyApiKey, maskApiKey } from "@revenium/cli";

const API_KEY = process.env.REVENIUM_API_KEY!;
const ENDPOINT = process.env.REVENIUM_ENDPOINT || "https://api.revenium.ai";

async function main() {
  console.log("Verifying API key:", maskApiKey(API_KEY));

  const isValid = await verifyApiKey(ENDPOINT, API_KEY);

  console.log("Valid:", isValid);
}

main().catch(console.error);
