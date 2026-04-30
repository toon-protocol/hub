import { describe, it, expect } from 'vitest';
import { chainFamilyOf } from './chain';

describe('chainFamilyOf', () => {
  it('returns evm for evm: prefix', () => {
    expect(chainFamilyOf('evm:base:31337')).toBe('evm');
    expect(chainFamilyOf('evm:8453')).toBe('evm');
  });

  it('returns solana for solana: prefix', () => {
    expect(chainFamilyOf('solana:devnet')).toBe('solana');
    expect(chainFamilyOf('solana:mainnet')).toBe('solana');
  });

  it('returns mina for mina: prefix', () => {
    expect(chainFamilyOf('mina:devnet')).toBe('mina');
  });

  it('returns unknown for unrecognized prefix', () => {
    expect(chainFamilyOf('btc:mainnet')).toBe('unknown');
    expect(chainFamilyOf('')).toBe('unknown');
  });
});
