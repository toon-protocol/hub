/**
 * Display helpers for Turbo credits + on-chain amounts (epic-49, Phase 2).
 *
 * Two concerns:
 *  1. Translate raw winc (winston credit, 1e-12 AR) into a "~N MB upload
 *     capacity" string for operator-facing surfaces. Per the plan: every winc
 *     value shown to a human should be accompanied by its bytes translation.
 *  2. Format on-chain base amounts (lamports, wei, USDC microunits) back into
 *     their human decimal representation for confirmation prompts.
 */

import type { TurboTokenId } from '../wallet/turbo-signer.js';

/**
 * Approximate winc-per-byte pricing constant. The Turbo SDK does NOT expose a
 * static converter — pricing is dynamic via `getTokenPriceForBytes` /
 * `getUploadCosts` (network calls). For at-a-glance display this constant is
 * good enough; precise quotes pass through the SDK.
 *
 * Reference: 1 GiB ≈ ~6.5e14 winc as of 2026-05 (varies with AR/USD rate and
 * network demand). 1 MiB ≈ 6.4e11 winc → 1 byte ≈ 6.1e5 winc.
 *
 * Update with the same cadence as ardrive's published pricing dashboard. This
 * is intentionally a single constant — if it drifts more than ±20% we should
 * be calling `getTokenPriceForBytes` for the display path too.
 */
const WINC_PER_BYTE_APPROX = 610_000n;

/**
 * Convert a winc balance into an approximate byte count.
 *
 * Pure BigInt division — no float math. Underestimates very small balances
 * (a wallet with <WINC_PER_BYTE_APPROX winc shows as "0 B"), which is the
 * correct semantic: you can't actually upload anything.
 */
function wincToBytes(winc: bigint): bigint {
  if (winc < 0n) return 0n;
  return winc / WINC_PER_BYTE_APPROX;
}

/**
 * Format a winc value as a human-friendly upload-capacity string.
 *
 * Examples:
 *   formatWincAsBytes(0n)              → "~0 B"
 *   formatWincAsBytes(6_100_000n)      → "~10 B"
 *   formatWincAsBytes(61_000_000_000n) → "~100 KB"
 *   formatWincAsBytes(610_000_000_000n)→ "~1 MB"
 *
 * Uses base-1000 (decimal SI) units to match how the ardrive UI presents
 * capacity. Rounds DOWN — never overstates available capacity.
 */
export function formatWincAsBytes(winc: bigint): string {
  const bytes = wincToBytes(winc);

  if (bytes < 1_000n) return `~${bytes.toString()} B`;
  if (bytes < 1_000_000n) {
    return `~${(bytes / 1_000n).toString()} KB`;
  }
  if (bytes < 1_000_000_000n) {
    return `~${(bytes / 1_000_000n).toString()} MB`;
  }
  if (bytes < 1_000_000_000_000n) {
    return `~${(bytes / 1_000_000_000n).toString()} GB`;
  }
  return `~${(bytes / 1_000_000_000_000n).toString()} TB`;
}

/**
 * Number of decimal places per token. Mirrors `@ardrive/turbo-sdk`
 * `exponentMap` for the tokens we support (see lib/types/common/token/index.d.ts
 * — exponentMap entries: ar=12, sol=9, eth/pol/base-eth=18, usdc=6).
 */
const TOKEN_DECIMALS: Record<TurboTokenId, number> = {
  ar: 12,
  sol: 9,
  eth: 18,
  pol: 18,
  'base-eth': 18,
  'base-usdc': 6,
  'usdc-eth': 6,
  'usdc-pol': 6,
};

/** Human-readable token symbol for display (uppercase per market convention). */
const TOKEN_SYMBOL: Record<TurboTokenId, string> = {
  ar: 'AR',
  sol: 'SOL',
  eth: 'ETH',
  pol: 'POL',
  'base-eth': 'ETH (Base)',
  'base-usdc': 'USDC (Base)',
  'usdc-eth': 'USDC (Ethereum)',
  'usdc-pol': 'USDC (Polygon)',
};

/**
 * Format a base-unit token amount (lamports, wei, USDC microunits, winston)
 * into a human decimal string with the token symbol.
 *
 * Examples:
 *   formatTokenAmount('sol', 1_000_000n)        → "0.001000000 SOL"
 *   formatTokenAmount('usdc-eth', 10_000_000n)  → "10.000000 USDC (Ethereum)"
 *   formatTokenAmount('eth', 1_000_000_000_000_000n) → "0.001000000000000000 ETH"
 *
 * Uses BigInt arithmetic exclusively — never float. Trailing zeros are
 * preserved so the decimal count visibly matches the token precision (an
 * operator confirming a SOL payment expects to see 9 decimals).
 */
export function formatTokenAmount(
  token: TurboTokenId,
  baseAmount: bigint
): string {
  const decimals = TOKEN_DECIMALS[token];
  const symbol = TOKEN_SYMBOL[token];
  if (decimals === undefined || symbol === undefined) {
    throw new Error(`Unknown TurboTokenId for formatting: ${String(token)}`);
  }

  const scale = 10n ** BigInt(decimals);
  const isNegative = baseAmount < 0n;
  const abs = isNegative ? -baseAmount : baseAmount;
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString().padStart(decimals, '0');
  const sign = isNegative ? '-' : '';
  return `${sign}${whole.toString()}.${fracStr} ${symbol}`;
}

/**
 * Parse a human decimal amount string (e.g. "0.05", "10", "1.234") to its
 * base-unit BigInt representation for the given token.
 *
 * Strict — rejects scientific notation, leading +, trailing characters,
 * and more decimal places than the token supports. Throws Error with a
 * caller-friendly message on failure.
 *
 * Examples:
 *   parseTokenAmount('sol', '0.001')      → 1_000_000n
 *   parseTokenAmount('usdc-eth', '10')    → 10_000_000n
 *   parseTokenAmount('eth', '0.0001')     → 100_000_000_000_000n
 */
export function parseTokenAmount(token: TurboTokenId, decimal: string): bigint {
  const decimals = TOKEN_DECIMALS[token];
  if (decimals === undefined) {
    throw new Error(`Unknown TurboTokenId: ${String(token)}`);
  }

  const trimmed = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid decimal amount '${decimal}' for token '${token}'. Use plain decimal notation (e.g. "0.05").`
    );
  }

  const [wholeStr, fracStr = ''] = trimmed.split('.');
  if (fracStr.length > decimals) {
    throw new Error(
      `Amount '${decimal}' has ${fracStr.length} decimal places, but '${token}' supports at most ${decimals}.`
    );
  }
  const fracPadded = fracStr.padEnd(decimals, '0');
  const whole = BigInt(wholeStr);
  const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
  return whole * 10n ** BigInt(decimals) + frac;
}
