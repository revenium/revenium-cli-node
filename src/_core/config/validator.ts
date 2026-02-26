import { API_KEY_PREFIX } from "../constants.js";
import type { ValidationResult } from "../types/index.js";

export function validateApiKey(apiKey: string): ValidationResult {
  const errors: string[] = [];

  if (!apiKey || apiKey.trim() === "") {
    errors.push("API key is required");
    return { valid: false, errors };
  }

  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    errors.push(`API key must start with "${API_KEY_PREFIX}"`);
  }

  const parts = apiKey.split("_");
  if (parts.length < 3) {
    errors.push("API key format should be: hak_{tenant}_{key}");
  }

  if (apiKey.length < 12) {
    errors.push("API key appears too short");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateEmail(email: string): ValidationResult {
  const errors: string[] = [];

  if (!email || email.trim() === "") {
    return { valid: true, errors: [] };
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    errors.push("Invalid email format");
  }

  if (email.length > 254) {
    errors.push("Email address is too long (max 254 characters)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateEndpointUrl(endpoint: string): ValidationResult {
  const errors: string[] = [];

  if (!endpoint || endpoint.trim() === "") {
    errors.push("Endpoint URL is required");
    return { valid: false, errors };
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push("Endpoint must use HTTP or HTTPS protocol");
    } else if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      errors.push("Endpoint must use HTTPS (except for localhost)");
    }
    if (url.username || url.password) {
      errors.push("Endpoint must not contain embedded credentials (username:password)");
    }
  } catch {
    errors.push("Invalid endpoint URL format");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateOrganizationName(name: string): ValidationResult {
  const errors: string[] = [];

  if (name && name.length > 255) {
    errors.push("Organization name is too long (max 255 characters)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateProductName(name: string): ValidationResult {
  const errors: string[] = [];

  if (name && name.length > 255) {
    errors.push("Product name is too long (max 255 characters)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
