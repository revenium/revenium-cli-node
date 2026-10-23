export function stripNewlines(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

export function escapeShellValue(value: string): string {
  return `'${stripNewlines(value).replace(/'/g, "'\\''")}'`;
}

export function escapeFishValue(value: string): string {
  return `'${stripNewlines(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function escapeResourceAttributeValue(value: string): string {
  return stripNewlines(value)
    .replace(/%/g, "%25")
    .replace(/\\/g, "%5C")
    .replace(/\$/g, "%24")
    .replace(/`/g, "%60")
    .replace(/,/g, "%2C")
    .replace(/=/g, "%3D")
    .replace(/"/g, "%22");
}
