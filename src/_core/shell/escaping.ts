export function escapeShellValue(value: string): string {
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

export function escapeDoubleQuotedShellValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

export function escapeFishValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

export function escapeResourceAttributeValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/,/g, "%2C").replace(/=/g, "%3D").replace(/"/g, "%22");
}
