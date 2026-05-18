import { describe, it, expect } from 'vitest';
import {
  computeUsdcScalars,
  usdcMicroToSats,
  formatSatsRow,
  renderEarningsSection,
  resolveSatsRate,
} from './status-earnings.js';
import type { AggregatedEarnings } from '../earnings/aggregator.js';

// Minimal fixture builders
function makeEarnings(
  override: Partial<AggregatedEarnings> = {}
): AggregatedEarnings {
  return {
    status: 'ok',
    apex: { routingFees: {} },
    peers: [],
    recentClaims: [],
    eventsRelayed: 0,
    uptimeSeconds: 0,
    ...override,
  };
}

function makePerAsset(lifetime: string, today = '0', month = '0', year = '0') {
  return { lifetime, today, month, year };
}

// ─── computeUsdcScalars ───────────────────────────────────────────────────────

describe('computeUsdcScalars', () => {
  it('returns zeros when no earnings', () => {
    const result = computeUsdcScalars(makeEarnings());
    expect(result).toEqual({
      today: '0',
      month: '0',
      year: '0',
      lifetime: '0',
    });
  });

  it('sums apex USDC routing fees', () => {
    const earnings = makeEarnings({
      apex: {
        routingFees: { USDC: makePerAsset('1000000', '100', '500', '900') },
      },
    });
    const result = computeUsdcScalars(earnings);
    expect(result.lifetime).toBe('1000000');
    expect(result.today).toBe('100');
    expect(result.month).toBe('500');
    expect(result.year).toBe('900');
  });

  it('sums single peer USDC earnings', () => {
    const earnings = makeEarnings({
      peers: [
        {
          id: 'town-01',
          type: 'town',
          byAsset: { USDC: makePerAsset('500000', '50', '200', '400') },
          lastClaimAt: null,
        },
      ],
    });
    const result = computeUsdcScalars(earnings);
    expect(result.lifetime).toBe('500000');
  });

  it('sums apex + multi-peer USDC', () => {
    const earnings = makeEarnings({
      apex: {
        routingFees: { USDC: makePerAsset('1000000', '100', '500', '900') },
      },
      peers: [
        {
          id: 'p1',
          type: 'town',
          byAsset: { USDC: makePerAsset('200000', '20', '80', '160') },
          lastClaimAt: null,
        },
        {
          id: 'p2',
          type: 'mill',
          byAsset: { USDC: makePerAsset('300000', '30', '120', '240') },
          lastClaimAt: null,
        },
      ],
    });
    const result = computeUsdcScalars(earnings);
    expect(result.lifetime).toBe('1500000');
    expect(result.today).toBe('150');
    expect(result.month).toBe('700');
    expect(result.year).toBe('1300');
  });

  it('ignores non-USDC assets', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { ETH: makePerAsset('1000000000000000000') } },
      peers: [
        {
          id: 'p1',
          type: 'mill',
          byAsset: { BTC: makePerAsset('100000000') },
          lastClaimAt: null,
        },
      ],
    });
    const result = computeUsdcScalars(earnings);
    expect(result).toEqual({
      today: '0',
      month: '0',
      year: '0',
      lifetime: '0',
    });
  });

  it('apex-only (no peers) works correctly', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('9999999') } },
    });
    expect(computeUsdcScalars(earnings).lifetime).toBe('9999999');
  });

  it('defends against malformed peer byAsset values', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('1000000') } },
      peers: [
        {
          id: 'p1',
          type: 'town',
          byAsset: { USDC: makePerAsset('not-a-number') },
          lastClaimAt: null,
        },
      ],
    });
    // malformed peer value is ignored (addDecimalStrings defends)
    expect(computeUsdcScalars(earnings).lifetime).toBe('1000000');
  });
});

// ─── usdcMicroToSats ─────────────────────────────────────────────────────────

describe('usdcMicroToSats', () => {
  it('zero USDC → 0 sats', () => {
    expect(usdcMicroToSats('0', 1500)).toBe('0');
  });

  it('1 USDC ($1.00) at 1500 sats/USDC = 1500 sats', () => {
    // 1 USDC = 1_000_000 micros
    expect(usdcMicroToSats('1000000', 1500)).toBe('1500');
  });

  it('fractional USDC truncates (floor division)', () => {
    // $0.50 = 500000 micros at 1500/USDC → 750 sats exactly
    expect(usdcMicroToSats('500000', 1500)).toBe('750');
    // $0.001 = 1000 micros at 1500/USDC → floor(1500/1000) = 1 sats
    expect(usdcMicroToSats('1000', 1500)).toBe('1');
    // $0.0001 = 100 micros at 1500/USDC → floor(150000/1000000) = 0 sats
    expect(usdcMicroToSats('100', 1500)).toBe('0');
  });

  it('negative USDC preserves sign, zero collapses negative', () => {
    expect(usdcMicroToSats('-1000000', 1500)).toBe('-1500');
    expect(usdcMicroToSats('-100', 1500)).toBe('0'); // rounds to 0, sign dropped
  });

  it('large value beyond Number.MAX_SAFE_INTEGER stays BigInt-safe', () => {
    // $1M lifetime = 1_000_000_000_000 micros at 100_000 sats/USDC
    const micros = '1000000000000'; // $1M
    const result = usdcMicroToSats(micros, 100000);
    // 1_000_000_000_000 * 100_000 / 1_000_000 = 100_000_000_000
    expect(result).toBe('100000000000');
  });

  it('throws for non-positive satsPerUsdc', () => {
    expect(() => usdcMicroToSats('1000000', 0)).toThrow();
    expect(() => usdcMicroToSats('1000000', -1)).toThrow();
  });

  it('returns 0 for malformed decimal string', () => {
    expect(usdcMicroToSats('abc', 1500)).toBe('0');
    expect(usdcMicroToSats('', 1500)).toBe('0');
    expect(usdcMicroToSats('1.5', 1500)).toBe('0');
  });
});

// ─── formatSatsRow ────────────────────────────────────────────────────────────

describe('formatSatsRow', () => {
  it('formats zero', () => {
    expect(formatSatsRow('0')).toBe('0 sats');
    expect(formatSatsRow('')).toBe('0 sats');
    expect(formatSatsRow('abc')).toBe('0 sats');
  });

  it('formats under-1000 value', () => {
    expect(formatSatsRow('750')).toBe('750 sats');
    expect(formatSatsRow('1')).toBe('1 sats');
  });

  it('formats value with one comma', () => {
    expect(formatSatsRow('1500')).toBe('1,500 sats');
    expect(formatSatsRow('12345')).toBe('12,345 sats');
  });

  it('formats value with two commas', () => {
    expect(formatSatsRow('1234567')).toBe('1,234,567 sats');
  });

  it('formats negative value', () => {
    expect(formatSatsRow('-1500')).toBe('-1,500 sats');
    expect(formatSatsRow('-0')).toBe('0 sats');
  });

  it('handles value beyond Number.MAX_SAFE_INTEGER via regex path', () => {
    // 90_071_992_547_409_960 is just over MAX_SAFE_INTEGER (9_007_199_254_740_991)
    const big = '90071992547409960';
    const result = formatSatsRow(big);
    expect(result).toBe('90,071,992,547,409,960 sats');
  });
});

// ─── renderEarningsSection ───────────────────────────────────────────────────

describe('renderEarningsSection', () => {
  it('returns unavailable line when connector is down', () => {
    const earnings = makeEarnings({ status: 'connector_unavailable' });
    const lines = renderEarningsSection({ earnings, units: 'usdc' });
    expect(lines).toContain('Earnings (USDC): unavailable');
    expect(lines.length).toBe(2); // blank + unavailable
  });

  it('sats mode + connector down still returns USDC unavailable line', () => {
    const earnings = makeEarnings({ status: 'connector_unavailable' });
    const lines = renderEarningsSection({
      earnings,
      units: 'sats',
      satsPerUsdc: 1500,
    });
    expect(lines).toContain('Earnings (USDC): unavailable');
  });

  it('USDC mode renders 7-line block with all labels', () => {
    const earnings = makeEarnings({
      apex: {
        routingFees: { USDC: makePerAsset('1000000', '1000', '5000', '9000') },
      },
    });
    const lines = renderEarningsSection({ earnings, units: 'usdc' });
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('Earnings (USDC):');
    expect(lines[2]).toBe('----------------');
    expect(lines.some((l) => l.includes('TODAY'))).toBe(true);
    expect(lines.some((l) => l.includes('MONTH'))).toBe(true);
    expect(lines.some((l) => l.includes('YEAR'))).toBe(true);
    expect(lines.some((l) => l.includes('LIFETIME'))).toBe(true);
    expect(lines.some((l) => l.includes('$1.00'))).toBe(true); // lifetime
  });

  it('USDC mode renders $0.00 for zero earnings', () => {
    const lines = renderEarningsSection({
      earnings: makeEarnings(),
      units: 'usdc',
    });
    expect(lines.filter((l) => l.includes('$0.00')).length).toBe(4);
  });

  it('sats mode renders rate in header and sats suffix', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('1000000') } },
    });
    const lines = renderEarningsSection({
      earnings,
      units: 'sats',
      satsPerUsdc: 1500,
    });
    expect(lines[1]).toBe('Earnings (sats @ 1500/USDC):');
    expect(lines.some((l) => l.includes('1,500 sats'))).toBe(true); // $1 USDC at 1500 = 1500 sats
    expect(lines.some((l) => l.includes('$'))).toBe(false);
  });

  it('sats mode header underline length matches header', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('0') } },
    });
    const lines = renderEarningsSection({
      earnings,
      units: 'sats',
      satsPerUsdc: 66666,
    });
    const header = lines[1];
    const underline = lines[2];
    expect(underline).toBe('-'.repeat(header.length));
  });

  // Defense-in-depth: direct library callers may bypass cli.ts's pre-call
  // guard. The function must reject malformed sats inputs with a clear error
  // rather than silently producing `Earnings (sats @ NaN/USDC):` or throwing
  // a low-level message from usdcMicroToSats.
  it('sats mode throws when satsPerUsdc is undefined', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('1000000') } },
    });
    expect(() => renderEarningsSection({ earnings, units: 'sats' })).toThrow(
      /positive-integer satsPerUsdc/
    );
  });

  it('sats mode throws when satsPerUsdc is zero or negative', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('1000000') } },
    });
    expect(() =>
      renderEarningsSection({ earnings, units: 'sats', satsPerUsdc: 0 })
    ).toThrow();
    expect(() =>
      renderEarningsSection({ earnings, units: 'sats', satsPerUsdc: -100 })
    ).toThrow();
  });

  it('sats mode throws when satsPerUsdc is non-integer', () => {
    const earnings = makeEarnings({
      apex: { routingFees: { USDC: makePerAsset('1000000') } },
    });
    expect(() =>
      renderEarningsSection({ earnings, units: 'sats', satsPerUsdc: 1.5 })
    ).toThrow();
    expect(() =>
      renderEarningsSection({
        earnings,
        units: 'sats',
        satsPerUsdc: Number.NaN,
      })
    ).toThrow();
  });
});

// ─── resolveSatsRate ─────────────────────────────────────────────────────────

describe('resolveSatsRate', () => {
  it('CLI flag wins over env var', () => {
    const result = resolveSatsRate(
      { rate: '1500' },
      { TOWNHOUSE_SATS_PER_USDC: '2500' }
    );
    expect(result).toEqual({ rate: 1500 });
  });

  it('env var used when no CLI flag', () => {
    const result = resolveSatsRate({}, { TOWNHOUSE_SATS_PER_USDC: '2500' });
    expect(result).toEqual({ rate: 2500 });
  });

  it('returns error when neither CLI nor env is set', () => {
    const result = resolveSatsRate({}, {});
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('--rate');
  });

  it('returns error for invalid rate: 0', () => {
    const result = resolveSatsRate({ rate: '0' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for negative rate', () => {
    const result = resolveSatsRate({ rate: '-1' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for decimal rate', () => {
    const result = resolveSatsRate({ rate: '1500.5' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for scientific notation rate', () => {
    const result = resolveSatsRate({ rate: '1e3' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for hex rate', () => {
    const result = resolveSatsRate({ rate: '0x10' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for empty string rate', () => {
    const result = resolveSatsRate({ rate: '' }, {});
    expect('error' in result).toBe(true);
  });

  it('returns error for whitespace rate', () => {
    const result = resolveSatsRate({ rate: ' 1500' }, {});
    expect('error' in result).toBe(true);
  });

  it('valid rate 1500 returns { rate: 1500 }', () => {
    expect(resolveSatsRate({ rate: '1500' }, {})).toEqual({ rate: 1500 });
  });

  it('valid rate 66666 returns { rate: 66666 }', () => {
    expect(resolveSatsRate({ rate: '66666' }, {})).toEqual({ rate: 66666 });
  });

  // Source attribution: when the bad value came from the env var, the error
  // message must not blame `--rate` (which the operator never typed).
  it('attributes env-var failures to TOWNHOUSE_SATS_PER_USDC, not --rate', () => {
    const result = resolveSatsRate({}, { TOWNHOUSE_SATS_PER_USDC: ' 1500' });
    expect('error' in result).toBe(true);
    const err = (result as { error: string }).error;
    expect(err).toContain('TOWNHOUSE_SATS_PER_USDC');
    expect(err).not.toMatch(/^--rate /);
  });

  it('attributes --rate failures to --rate (not env var)', () => {
    const result = resolveSatsRate({ rate: '1.5' }, {});
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('--rate');
  });

  // Empty --rate should not shadow a valid env var (nullish coalescing
  // doesn't fall through on empty string, so the original code mis-rejected).
  it('empty --rate falls through to TOWNHOUSE_SATS_PER_USDC env var', () => {
    const result = resolveSatsRate(
      { rate: '' },
      { TOWNHOUSE_SATS_PER_USDC: '2500' }
    );
    expect(result).toEqual({ rate: 2500 });
  });

  it('empty --rate with no env returns the missing-rate error', () => {
    const result = resolveSatsRate({ rate: '' }, {});
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain(
      '--units=sats requires --rate'
    );
  });
});
