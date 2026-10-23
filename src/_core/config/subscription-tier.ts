export function parseSubscriptionTier<T extends string>(
  value: string | undefined,
  tiers: ReadonlyArray<T>,
): T | undefined {
  return tiers.includes(value as T) ? (value as T) : undefined;
}
