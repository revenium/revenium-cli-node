import { abortSetup } from "../ui/abort-setup.js";
import { printWriteKeyWarning } from "../ui/write-key-warning.js";
import { classifyApiKeyScope } from "./key-scope.js";
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  validateOrganizationName,
  validateProductName,
} from "./validator.js";

export interface SetupInputs {
  apiKey: string;
  email?: string;
  endpoint: string;
  managementEndpoint?: string;
  organizationName?: string;
  productName?: string;
}

export function enforceSetupFlags(flags: Partial<SetupInputs>): void {
  abortOnErrors(collectErrors(flags));
}

export function enforceSetupInputs(inputs: SetupInputs): void {
  if (abortOnErrors(collectErrors(inputs))) return;

  if (classifyApiKeyScope(inputs.apiKey) === "write") {
    printWriteKeyWarning();
  }
}

function collectErrors(inputs: Partial<SetupInputs>): string[] {
  const errors: string[] = [];

  if (inputs.apiKey !== undefined) {
    errors.push(...validateApiKey(inputs.apiKey).errors);
  }

  errors.push(...validateEmail(normalize(inputs.email)).errors);

  if (inputs.endpoint !== undefined) {
    errors.push(...validateEndpointUrl(inputs.endpoint).errors);
  }

  if (inputs.managementEndpoint !== undefined) {
    errors.push(...validateEndpointUrl(inputs.managementEndpoint).errors);
  }

  errors.push(...validateOrganizationName(normalize(inputs.organizationName)).errors);
  errors.push(...validateProductName(normalize(inputs.productName)).errors);

  return errors;
}

function abortOnErrors(errors: string[]): boolean {
  if (errors.length === 0) return false;

  abortSetup(errors.join(", "));
  return true;
}

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}
