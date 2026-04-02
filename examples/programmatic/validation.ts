import { validateApiKey, validateEmail, validateEndpointUrl } from "@revenium/cli";

const apiKeyResult = validateApiKey("hak_tenant_mykey123456");
console.log("API Key valid:", apiKeyResult.valid);
if (!apiKeyResult.valid) {
  console.log("Errors:", apiKeyResult.errors);
}

const emailResult = validateEmail("user@example.com");
console.log("\nEmail valid:", emailResult.valid);

const endpointResult = validateEndpointUrl("https://api.revenium.ai");
console.log("\nEndpoint valid:", endpointResult.valid);

const invalidKeyResult = validateApiKey("invalid-key");
console.log("\nInvalid key errors:", invalidKeyResult.errors);
