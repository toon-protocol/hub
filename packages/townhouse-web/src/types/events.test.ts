/**
 * Tests for `SettlementEvent` consumer-side type — Story D3 AC-D3-3, AC-D3-4.
 *
 * Exercises the type guard and asserts EVM + Solana fixtures conform to
 * the documented shape. D4's earnings aggregator relies on
 * `hasSettlementTxFields()` returning `true` for the same inputs we
 * assert here.
 */

import { describe, it, expect } from 'vitest';

import {
  hasSettlementTxFields,
  type SettlementEvent,
  type SettlementChain,
} from './events';

const EVM_FIXTURE: SettlementEvent = {
  txHash: '0xabc1234567890123456789012345678901234567890123456789012345678901',
  chain: 'evm',
  channelId: '0xfeedface00000000000000000000000000000000',
  cumulativeAmount: '1000000',
  nonce: '1',
  recipient: '0x1111111111111111111111111111111111111111',
  settledAt: 1700000000000,
};

const SOLANA_FIXTURE: SettlementEvent = {
  txHash:
    '5VfYmfXkVuPkH4XJYUogWQabXpvF9DAxwLhx1HpTphQ5Yh8WqYwZxSEAuwTk7TuY1zXZF7L9DX2pRuNMC5xuKvaP',
  chain: 'solana',
  channelId: '8r2YBvgNYmTXbaUZqczD7TxfzBxtHzFx7sYGm9hg9HzQ',
  cumulativeAmount: '500000',
  nonce: '7',
  recipient: '4Nd1mFuuy3HRKFWvhd8L9pmLTCnD4kdWkJWj7QVAwfDF',
  settledAt: 1700000001000,
};

describe('Story D3 AC-D3-3, AC-D3-4 — SettlementEvent (townhouse-web)', () => {
  it('[P0] (T-D3-4) EVM fixture exposes txHash + chain="evm"', () => {
    expect(EVM_FIXTURE.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(EVM_FIXTURE.chain).toBe<SettlementChain>('evm');
    expect(hasSettlementTxFields(EVM_FIXTURE)).toBe(true);
  });

  it('[P0] Solana fixture exposes base58 txHash + chain="solana"', () => {
    expect(SOLANA_FIXTURE.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(SOLANA_FIXTURE.chain).toBe<SettlementChain>('solana');
    expect(hasSettlementTxFields(SOLANA_FIXTURE)).toBe(true);
  });

  it('[P1] hasSettlementTxFields returns false when txHash is missing', () => {
    expect(hasSettlementTxFields({ chain: 'evm' })).toBe(false);
    expect(hasSettlementTxFields({ chain: 'evm', txHash: '' })).toBe(false);
  });

  it('[P1] hasSettlementTxFields returns false when chain is missing or unsupported', () => {
    expect(hasSettlementTxFields({ txHash: EVM_FIXTURE.txHash })).toBe(false);
    expect(
      hasSettlementTxFields({
        txHash: EVM_FIXTURE.txHash,
        // @ts-expect-error — guard rejects unsupported chain at runtime
        chain: 'mina',
      })
    ).toBe(false);
  });

  it('[P1] hasSettlementTxFields handles null / undefined defensively', () => {
    expect(hasSettlementTxFields(null)).toBe(false);
    expect(hasSettlementTxFields(undefined)).toBe(false);
  });

  it('[P2] all SettlementEvent fields are optional (additive backward compat)', () => {
    // A pre-D3 caller MUST be able to construct an empty {} event.
    const empty: SettlementEvent = {};
    expect(empty).toEqual({});
    expect(hasSettlementTxFields(empty)).toBe(false);
  });
});
