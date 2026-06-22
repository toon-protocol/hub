/**
 * Unit tests for credits display + parsing helpers (epic-49, Phase 2).
 *
 * Covers:
 *   - winc → bytes rounding boundaries (B/KB/MB/GB/TB)
 *   - token amount formatting decimals per token
 *   - human-decimal parsing precision + rejection of malformed inputs
 */

import { describe, it, expect } from 'vitest';

import {
  formatTokenAmount,
  formatWincAsBytes,
  parseTokenAmount,
} from './units.js';
import type { TurboTokenId } from '../wallet/turbo-signer.js';

// ── formatWincAsBytes ─────────────────────────────────────────────────────

describe('formatWincAsBytes — boundary rounding', () => {
  it('returns "~0 B" for zero winc', () => {
    expect(formatWincAsBytes(0n)).toBe('~0 B');
  });

  it('returns bytes for tiny balances below 1 KB', () => {
    // 1 byte ≈ 610_000 winc, so 6_100_000 winc → ~10 B.
    expect(formatWincAsBytes(6_100_000n)).toBe('~10 B');
  });

  it('rolls over to KB at 1000 bytes', () => {
    // 1000 bytes * 610_000 winc/byte = 610_000_000 winc.
    expect(formatWincAsBytes(610_000_000n)).toBe('~1 KB');
  });

  it('rolls over to MB at 1_000_000 bytes', () => {
    // 1_000_000 bytes * 610_000 winc/byte = 6.1e11 winc.
    expect(formatWincAsBytes(610_000_000_000n)).toBe('~1 MB');
  });

  it('rolls over to GB at 1e9 bytes', () => {
    // 1e9 bytes * 610_000 winc/byte = 6.1e14 winc.
    expect(formatWincAsBytes(610_000_000_000_000n)).toBe('~1 GB');
  });

  it('rolls over to TB at 1e12 bytes', () => {
    // 1e12 bytes * 610_000 winc/byte = 6.1e17 winc.
    expect(formatWincAsBytes(610_000_000_000_000_000n)).toBe('~1 TB');
  });

  it('rounds DOWN — never overstates capacity', () => {
    // 999_999 winc → only 1 byte (1.63… rounded down to 1).
    expect(formatWincAsBytes(999_999n)).toBe('~1 B');
    // 609_999 winc → 0 bytes (under 1 byte threshold).
    expect(formatWincAsBytes(609_999n)).toBe('~0 B');
  });

  it('treats negative winc as zero (defensive)', () => {
    expect(formatWincAsBytes(-1n)).toBe('~0 B');
  });
});

// ── formatTokenAmount ─────────────────────────────────────────────────────

describe('formatTokenAmount — per-token decimal precision', () => {
  it('SOL — 9 decimals', () => {
    expect(formatTokenAmount('sol', 1_000_000n)).toBe('0.001000000 SOL');
    expect(formatTokenAmount('sol', 1_000_000_000n)).toBe('1.000000000 SOL');
  });

  it('ETH — 18 decimals', () => {
    expect(formatTokenAmount('eth', 1_000_000_000_000_000n)).toBe(
      '0.001000000000000000 ETH'
    );
  });

  it('USDC (Ethereum) — 6 decimals', () => {
    expect(formatTokenAmount('usdc-eth', 10_000_000n)).toBe(
      '10.000000 USDC (Ethereum)'
    );
  });

  it('USDC (Polygon) — 6 decimals + symbol distinction', () => {
    expect(formatTokenAmount('usdc-pol', 1_234_567n)).toBe(
      '1.234567 USDC (Polygon)'
    );
  });

  it('AR — 12 decimals (winston)', () => {
    expect(formatTokenAmount('ar', 1_000_000_000_000n)).toBe(
      '1.000000000000 AR'
    );
  });

  it('handles negative amounts with a leading sign', () => {
    expect(formatTokenAmount('sol', -1_000_000n)).toBe('-0.001000000 SOL');
  });

  it('throws for an unknown token id', () => {
    expect(() => formatTokenAmount('btc' as TurboTokenId, 1n)).toThrow(
      /Unknown TurboTokenId/
    );
  });
});

// ── parseTokenAmount ──────────────────────────────────────────────────────

describe('parseTokenAmount — human decimal → base units (BigInt)', () => {
  it('parses "0.001" SOL → 1_000_000 lamports', () => {
    expect(parseTokenAmount('sol', '0.001')).toBe(1_000_000n);
  });

  it('parses "10" USDC → 10_000_000 (6 decimals)', () => {
    expect(parseTokenAmount('usdc-eth', '10')).toBe(10_000_000n);
  });

  it('parses "0.0001" ETH → 1e14 wei', () => {
    expect(parseTokenAmount('eth', '0.0001')).toBe(100_000_000_000_000n);
  });

  it('parses integer amount with no decimal point', () => {
    expect(parseTokenAmount('sol', '1')).toBe(1_000_000_000n);
  });

  it('handles trailing whitespace', () => {
    expect(parseTokenAmount('sol', '  0.001  ')).toBe(1_000_000n);
  });

  it('rejects scientific notation', () => {
    expect(() => parseTokenAmount('sol', '1e-3')).toThrow(/Invalid decimal/);
  });

  it('rejects leading "+"', () => {
    expect(() => parseTokenAmount('sol', '+1')).toThrow(/Invalid decimal/);
  });

  it('rejects negative amounts (use unsigned amounts only)', () => {
    expect(() => parseTokenAmount('sol', '-0.001')).toThrow(/Invalid decimal/);
  });

  it('rejects more decimal places than the token supports', () => {
    // SOL = 9 decimals. 10 decimals should reject.
    expect(() => parseTokenAmount('sol', '0.1234567890')).toThrow(
      /decimal places.*supports at most 9/
    );
  });

  it('accepts exactly maxDecimals places', () => {
    expect(parseTokenAmount('sol', '0.123456789')).toBe(123_456_789n);
  });

  it('rejects empty input', () => {
    expect(() => parseTokenAmount('sol', '')).toThrow(/Invalid decimal/);
  });

  it('rejects pure whitespace', () => {
    expect(() => parseTokenAmount('sol', '   ')).toThrow(/Invalid decimal/);
  });

  it('rejects garbage characters', () => {
    expect(() => parseTokenAmount('sol', '0.1abc')).toThrow(/Invalid decimal/);
  });
});

describe('parseTokenAmount + formatTokenAmount — round trip', () => {
  it('SOL round trip preserves base-unit value', () => {
    const base = parseTokenAmount('sol', '1.234567890');
    expect(base).toBe(1_234_567_890n);
    expect(formatTokenAmount('sol', base)).toBe('1.234567890 SOL');
  });

  it('USDC round trip preserves precision', () => {
    const base = parseTokenAmount('usdc-eth', '100.000001');
    expect(base).toBe(100_000_001n);
    expect(formatTokenAmount('usdc-eth', base)).toBe(
      '100.000001 USDC (Ethereum)'
    );
  });
});
