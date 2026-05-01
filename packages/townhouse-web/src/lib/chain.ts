/** Derive the chain family from a TOON chain string (e.g. "evm:base:31337" → "evm"). */
export function chainFamilyOf(
  chain: string
): 'evm' | 'solana' | 'mina' | 'unknown' {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return 'unknown';
}
