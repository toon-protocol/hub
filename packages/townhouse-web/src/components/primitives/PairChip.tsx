import * as React from 'react';
import { cn } from '@/lib/utils';
import { ChainIcon } from './ChainIcon';
import { TokenIcon } from './TokenIcon';
import { chainFamilyOf } from '@/lib/chain';

export interface PairChipProps {
  from: { asset: string; chain: string };
  to: { asset: string; chain: string };
  rate?: string;
  className?: string;
}

type KnownToken = 'USDC' | 'ETH' | 'SOL' | 'MINA';
const KNOWN_TOKENS = new Set<KnownToken>(['USDC', 'ETH', 'SOL', 'MINA']);

function toTokenIcon(asset: string): KnownToken | null {
  const upper = asset.toUpperCase() as KnownToken;
  return KNOWN_TOKENS.has(upper) ? upper : null;
}

function AssetLabel({ asset, chain }: { asset: string; chain: string }) {
  const family = chainFamilyOf(chain);
  const token = toTokenIcon(asset);
  const chainFamily = family === 'unknown' ? undefined : family;
  return (
    <span className="flex items-center gap-0.5">
      {token && <TokenIcon token={token} size={12} />}
      {chainFamily && <ChainIcon chain={chainFamily} size={12} />}
      <span className="font-geist-mono text-xs text-ink/80">{asset}</span>
    </span>
  );
}

/** Shadow-bordered chip showing a swap pair with optional exchange rate. */
export function PairChip({ from, to, rate, className }: PairChipProps) {
  return (
    <div
      className={cn(
        'shadow-border inline-flex items-center gap-1.5 rounded-md bg-canvas px-2 py-1',
        className
      )}
    >
      <AssetLabel asset={from.asset} chain={from.chain} />
      <span className="font-geist-mono text-xs text-ink/40">↔</span>
      <AssetLabel asset={to.asset} chain={to.chain} />
      {rate !== undefined && (
        <span className="font-geist-mono ml-1 text-xs tabular-nums text-ink/50">{rate}</span>
      )}
    </div>
  );
}

PairChip.displayName = 'PairChip';
