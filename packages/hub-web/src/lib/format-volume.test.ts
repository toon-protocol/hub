import { describe, it, expect } from 'vitest';
import { formatVolume } from './format-volume';

describe('formatVolume', () => {
  it('assetScale 6 — formats USDC-like values', () => {
    expect(formatVolume('1234567', 6)).toBe('1.234567');
    expect(formatVolume('1000000', 6)).toBe('1');
    expect(formatVolume('500000', 6)).toBe('0.5');
  });

  it('assetScale 18 — formats ETH-like values without precision loss', () => {
    expect(formatVolume('1000000000000000000', 18)).toBe('1');
    expect(formatVolume('123456789012345678', 18)).toBe('0.123456789012345678');
  });

  it('zero value returns "0"', () => {
    expect(formatVolume('0', 6)).toBe('0');
  });

  it('trailing zeros in fractional part are stripped', () => {
    expect(formatVolume('100000', 6)).toBe('0.1');
  });

  it('malformed input returns the original string', () => {
    expect(formatVolume('not-a-number', 6)).toBe('not-a-number');
  });

  it('large values are formatted without precision loss', () => {
    // 10 ETH in wei (assetScale 18)
    expect(formatVolume('10000000000000000000', 18)).toBe('10');
  });
});
