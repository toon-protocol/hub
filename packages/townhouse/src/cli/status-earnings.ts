import type { AggregatedEarnings } from '../earnings/aggregator.js';
import { formatUsdc } from '../tui/format.js';

export const USDC_SCALE = 6;
const USDC_ASSET = 'USDC';
const DECIMAL_RE = /^-?\d+$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

export interface EarningsRow {
  today: string;
  month: string;
  year: string;
  lifetime: string;
}

function addDecimalStrings(a: string, b: string): string {
  if (!DECIMAL_RE.test(b)) return a;
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

export function computeUsdcScalars(earnings: AggregatedEarnings): EarningsRow {
  let today = '0';
  let month = '0';
  let year = '0';
  let lifetime = '0';

  const apexUsdc = earnings.apex.routingFees[USDC_ASSET];
  if (apexUsdc !== undefined) {
    today = addDecimalStrings(today, apexUsdc.today);
    month = addDecimalStrings(month, apexUsdc.month);
    year = addDecimalStrings(year, apexUsdc.year);
    lifetime = addDecimalStrings(lifetime, apexUsdc.lifetime);
  }

  for (const peer of earnings.peers) {
    const peerUsdc = peer.byAsset[USDC_ASSET];
    if (peerUsdc !== undefined) {
      today = addDecimalStrings(today, peerUsdc.today);
      month = addDecimalStrings(month, peerUsdc.month);
      year = addDecimalStrings(year, peerUsdc.year);
      lifetime = addDecimalStrings(lifetime, peerUsdc.lifetime);
    }
  }

  return { today, month, year, lifetime };
}

export function usdcMicroToSats(
  decimalString: string,
  satsPerUsdc: number
): string {
  if (!DECIMAL_RE.test(decimalString)) return '0';
  if (!Number.isInteger(satsPerUsdc) || satsPerUsdc <= 0) {
    throw new Error('satsPerUsdc must be a positive integer');
  }
  const negative = decimalString.startsWith('-');
  const absolute = negative ? decimalString.slice(1) : decimalString;
  const sats =
    (BigInt(absolute) * BigInt(satsPerUsdc)) / 10n ** BigInt(USDC_SCALE);
  return (negative && sats !== 0n ? '-' : '') + sats.toString();
}

export function formatSatsRow(value: string): string {
  if (!value || !DECIMAL_RE.test(value)) return '0 sats';
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  if (!abs || abs === '0') return '0 sats';

  let formatted: string;
  const absN = BigInt(abs);
  if (absN < BigInt(Number.MAX_SAFE_INTEGER)) {
    formatted = Number(abs).toLocaleString('en-US');
  } else {
    formatted = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return (negative ? '-' : '') + formatted + ' sats';
}

export function renderEarningsSection(opts: {
  earnings: AggregatedEarnings;
  units: 'usdc' | 'sats';
  satsPerUsdc?: number;
}): string[] {
  if (opts.earnings.status === 'connector_unavailable') {
    return ['', 'Earnings (USDC): unavailable'];
  }

  const scalars = computeUsdcScalars(opts.earnings);

  if (opts.units === 'usdc') {
    return [
      '',
      'Earnings (USDC):',
      '----------------',
      `  TODAY    ${formatUsdc(scalars.today, USDC_SCALE)}`,
      `  MONTH    ${formatUsdc(scalars.month, USDC_SCALE)}`,
      `  YEAR     ${formatUsdc(scalars.year, USDC_SCALE)}`,
      `  LIFETIME ${formatUsdc(scalars.lifetime, USDC_SCALE)}`,
    ];
  }

  if (
    opts.satsPerUsdc === undefined ||
    !Number.isInteger(opts.satsPerUsdc) ||
    opts.satsPerUsdc <= 0
  ) {
    throw new Error(
      "renderEarningsSection: units='sats' requires a positive-integer satsPerUsdc"
    );
  }
  const rate = opts.satsPerUsdc;
  const header = `Earnings (sats @ ${rate}/USDC):`;
  return [
    '',
    header,
    '-'.repeat(header.length),
    `  TODAY    ${formatSatsRow(usdcMicroToSats(scalars.today, rate))}`,
    `  MONTH    ${formatSatsRow(usdcMicroToSats(scalars.month, rate))}`,
    `  YEAR     ${formatSatsRow(usdcMicroToSats(scalars.year, rate))}`,
    `  LIFETIME ${formatSatsRow(usdcMicroToSats(scalars.lifetime, rate))}`,
  ];
}

export function resolveSatsRate(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): { rate: number } | { error: string } {
  // Treat empty --rate as absent so a valid env var can still take effect.
  const cliRaw =
    typeof values['rate'] === 'string' ? (values['rate'] as string) : undefined;
  const cliRate = cliRaw !== undefined && cliRaw !== '' ? cliRaw : undefined;
  const envRate = env['TOWNHOUSE_SATS_PER_USDC'];
  const raw = cliRate ?? envRate;
  const source =
    cliRate !== undefined ? '--rate' : 'TOWNHOUSE_SATS_PER_USDC env var';

  if (raw === undefined) {
    return {
      error:
        '--units=sats requires --rate <sats-per-usdc> or TOWNHOUSE_SATS_PER_USDC env var (e.g. --rate 1500 for 1500 sats per 1 USDC)',
    };
  }

  if (!POSITIVE_INT_RE.test(raw)) {
    return {
      error: `${source} must be a positive integer (sats per 1 USDC); got: ${JSON.stringify(raw)}`,
    };
  }

  const rate = Number(raw);
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    return { error: `${source} is out of range` };
  }

  return { rate };
}
