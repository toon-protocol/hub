const DECIMAL_RE = /^-?\d+$/;
const MICRO_FRACTIONAL_DIGITS = 4;

export function formatRelativeTime(
  iso: string | null,
  now: Date = new Date()
): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  // Clamp negative deltas (future-dated `at` from host/container clock skew) to 0.
  // Without the clamp, a claim ~hours in the future would silently render `<1m ago`
  // because every negative value already trips the `< 60` shortcut; the clamp makes
  // the future-tolerance contract explicit instead of incidental.
  const deltaSec = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
  if (deltaSec < 60) return '<1m ago';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  if (deltaSec < 2_592_000) return `${Math.floor(deltaSec / 86_400)}d ago`;
  return `${Math.floor(deltaSec / 2_592_000)}mo ago`;
}

export function formatUsdcMicro(decimalString: string, scale: number): string {
  if (!DECIMAL_RE.test(decimalString)) {
    const env = process.env['NODE_ENV'];
    if (env === 'development' || env === 'test') {
      throw new Error(
        `formatUsdcMicro: invalid decimal string: ${JSON.stringify(decimalString)}`
      );
    }
    return '$?.????';
  }

  const negative = decimalString.startsWith('-');
  const abs = negative ? decimalString.slice(1) : decimalString;

  const divisor = BigInt(10) ** BigInt(scale);
  const value = BigInt(abs);

  const whole = value / divisor;
  const remainder = value % divisor;

  const fractionalStr = remainder.toString().padStart(scale, '0');
  const cents = fractionalStr
    .slice(0, MICRO_FRACTIONAL_DIGITS)
    .padEnd(MICRO_FRACTIONAL_DIGITS, '0');

  const formatted = `$${whole.toString()}.${cents}`;
  return negative && value !== 0n ? `-${formatted}` : formatted;
}

export function formatUsdc(decimalString: string, scale: number): string {
  if (!DECIMAL_RE.test(decimalString)) {
    const env = process.env['NODE_ENV'];
    if (env === 'development' || env === 'test') {
      throw new Error(
        `formatUsdc: invalid decimal string: ${JSON.stringify(decimalString)}`
      );
    }
    return '$?.??';
  }

  const negative = decimalString.startsWith('-');
  const abs = negative ? decimalString.slice(1) : decimalString;

  const divisor = BigInt(10) ** BigInt(scale);
  const value = BigInt(abs);

  // Truncate (do NOT round) — connector posture.
  const whole = value / divisor;
  const remainder = value % divisor;

  const fractionalStr = remainder.toString().padStart(scale, '0');
  const cents = fractionalStr.slice(0, 2).padEnd(2, '0');

  const formatted = `$${whole.toString()}.${cents}`;
  // Suppress `-$0.00` — value === 0n collapses negative zero.
  return negative && value !== 0n ? `-${formatted}` : formatted;
}
