export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) {
    return "***";
  }

  const prefix = apiKey.substring(0, 4);
  const lastFour = apiKey.substring(apiKey.length - 4);
  return `${prefix}***${lastFour}`;
}

export function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    return "***";
  }

  const firstChar = email.charAt(0);
  const domain = email.substring(atIndex);
  return `${firstChar}***${domain}`;
}
