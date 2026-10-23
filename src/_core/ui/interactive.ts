import { abortSetup } from "./abort-setup.js";

export interface RequiredOption {
  flag: string;
  value?: string;
  allowedValues?: ReadonlyArray<string>;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function isUnsupportedValue(option: RequiredOption): boolean {
  return Boolean(option.allowedValues && !option.allowedValues.includes(option.value as string));
}

export function requireOptions(required: RequiredOption[]): void {
  const missing = required.filter((option) => !option.value).map((option) => option.flag);

  if (missing.length > 0) {
    abortSetup(
      `Non-interactive run: missing required option(s) ${missing.join(", ")}. Pass them on the command line or run setup in a terminal.`,
    );
  }

  const unsupported = required
    .filter(isUnsupportedValue)
    .map((option) => `${option.flag} (expected one of: ${option.allowedValues!.join(", ")})`);

  if (unsupported.length > 0) {
    abortSetup(`Non-interactive run: unsupported value for ${unsupported.join(", ")}.`);
  }
}
