import { maskApiKey, maskEmail } from "@revenium/cli";

console.log("API Key masking:");
console.log("  hak_tenant_abc123xyz789 ->", maskApiKey("hak_tenant_abc123xyz789"));
console.log("  short ->", maskApiKey("short"));

console.log("\nEmail masking:");
console.log("  user@example.com ->", maskEmail("user@example.com"));
console.log("  admin@revenium.io ->", maskEmail("admin@revenium.io"));
