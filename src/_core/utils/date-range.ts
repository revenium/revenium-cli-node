const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function toInclusiveRangeEnd(input: string, parsed: Date): Date {
  if (!DATE_ONLY_PATTERN.test(input)) return parsed;
  return new Date(`${input}T23:59:59.999Z`);
}
