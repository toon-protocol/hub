import { describe, it, expect, afterEach } from 'vitest';
import { formatUsdc, formatUsdcMicro, formatRelativeTime } from './format.js';

describe('formatUsdc', () => {
  const origEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
  });

  it('formats a standard USDC amount', () => {
    expect(formatUsdc('1234567', 6)).toBe('$1.23');
  });

  it('formats zero', () => {
    expect(formatUsdc('0', 6)).toBe('$0.00');
  });

  it('formats a negative amount', () => {
    expect(formatUsdc('-500000', 6)).toBe('-$0.50');
  });

  it('formats a large amount', () => {
    expect(formatUsdc('999999999999999999', 6)).toBe('$999999999999.99');
  });

  it('throws on non-decimal input in dev mode', () => {
    process.env['NODE_ENV'] = 'development';
    expect(() => formatUsdc('not-a-number', 6)).toThrow(
      'invalid decimal string'
    );
  });

  it('throws on non-decimal input in test mode', () => {
    process.env['NODE_ENV'] = 'test';
    expect(() => formatUsdc('not-a-number', 6)).toThrow(
      'invalid decimal string'
    );
  });

  it('returns $?.?? on non-decimal input in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(formatUsdc('not-a-number', 6)).toBe('$?.??');
  });

  it('returns $?.?? when NODE_ENV is undefined (treated as production)', () => {
    delete process.env['NODE_ENV'];
    expect(formatUsdc('not-a-number', 6)).toBe('$?.??');
  });

  it('formats at scale 2', () => {
    expect(formatUsdc('1234', 2)).toBe('$12.34');
  });

  it('pads cents at scale 1 (one fractional digit → two)', () => {
    expect(formatUsdc('123', 1)).toBe('$12.30');
  });

  it('suppresses negative sign on negative zero', () => {
    expect(formatUsdc('-0', 6)).toBe('$0.00');
  });
});

describe('formatUsdcMicro', () => {
  const origEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
  });

  it('formats a standard USDC micropayment at 4 decimals', () => {
    expect(formatUsdcMicro('12000', 6)).toBe('$0.0120');
  });

  it('formats a negative micropayment', () => {
    expect(formatUsdcMicro('-12000', 6)).toBe('-$0.0120');
  });

  it('returns $?.???? on malformed input in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(formatUsdcMicro('bad', 6)).toBe('$?.????');
  });

  it('truncates the fifth+ digit (does NOT round to nearest) — P5 boundary', () => {
    // 19999 at scale 6 = 0.019999 → truncate (NOT round) at 4 decimals → $0.0199.
    // A future contributor "fixing" to Math.round would silently shift every
    // displayed amount.
    expect(formatUsdcMicro('19999', 6)).toBe('$0.0199');
  });
});

describe('formatRelativeTime', () => {
  it('returns em-dash for null', () => {
    expect(formatRelativeTime(null, new Date('2026-05-14T12:00:00Z'))).toBe(
      '—'
    );
  });

  it('returns ? for non-ISO input', () => {
    expect(
      formatRelativeTime('not-an-iso', new Date('2026-05-14T12:00:00Z'))
    ).toBe('?');
  });

  it('returns <1m ago for delta < 60s', () => {
    expect(
      formatRelativeTime(
        '2026-05-14T11:59:30Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('<1m ago');
  });

  it('returns Nm ago for delta in minutes', () => {
    expect(
      formatRelativeTime(
        '2026-05-14T11:55:00Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('5m ago');
  });

  it('returns Nh ago for delta in hours', () => {
    expect(
      formatRelativeTime(
        '2026-05-14T10:00:00Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('2h ago');
  });

  it('returns Nd ago for delta in days', () => {
    expect(
      formatRelativeTime(
        '2026-05-12T12:00:00Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('2d ago');
  });

  it('returns Nmo ago for delta in months', () => {
    expect(
      formatRelativeTime(
        '2026-02-14T12:00:00Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('2mo ago');
  });

  it('truncates (floor) rather than rounds minutes', () => {
    // 89s → Math.floor(89/60) = 1m, not 2m
    expect(
      formatRelativeTime(
        '2026-05-14T11:58:31Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('1m ago');
  });

  it('returns <1m ago for future ISO (negative delta treated as <1m)', () => {
    expect(
      formatRelativeTime(
        '2026-05-14T12:01:00Z',
        new Date('2026-05-14T12:00:00Z')
      )
    ).toBe('<1m ago');
  });

  it('handles real-world aggregator ISO with ms precision', () => {
    expect(
      formatRelativeTime(
        '2026-05-13T18:42:11.123Z',
        new Date('2026-05-14T06:42:11.123Z')
      )
    ).toBe('12h ago');
  });
});
