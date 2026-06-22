/**
 * Format a bigint-encoded volume string to a human-readable decimal.
 * Stays in BigInt domain to avoid precision loss at assetScale ≥ 16.
 */
export function formatVolume(volume: string, assetScale: number): string {
  try {
    const raw = BigInt(volume);
    const divisor = 10n ** BigInt(assetScale);
    const whole = raw / divisor;
    const frac = raw % divisor;
    const fracStr = frac
      .toString()
      .padStart(assetScale, '0')
      .replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return volume;
  }
}
