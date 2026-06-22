import * as React from 'react';
import { cn } from '@/lib/utils';

export interface LiquidityBarProps {
  allocated: bigint;
  inActiveSwaps: bigint;
  available: bigint;
  total: bigint;
  chainLabel: string;
  assetCode: string;
  pulse?: boolean;
  className?: string;
}

function pct(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  const raw = Number((part * 10000n) / total) / 100;
  return Math.max(0, Math.min(100, raw));
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function clampToSafeNumber(b: bigint): number {
  if (b <= 0n) return 0;
  if (b >= MAX_SAFE) return Number.MAX_SAFE_INTEGER;
  return Number(b);
}

/** Horizontal segmented bar showing allocated / in-flight / available inventory. */
export function LiquidityBar({
  allocated,
  inActiveSwaps,
  available,
  total,
  chainLabel,
  assetCode,
  pulse = false,
  className,
}: LiquidityBarProps) {
  const allocPct = pct(allocated, total);
  const activePct = pct(inActiveSwaps, total);
  const availPct = pct(available, total);

  const ariaLabel = `${chainLabel} ${assetCode} liquidity: ${available.toString()} available of ${total.toString()} total`;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div
        role="meter"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={clampToSafeNumber(total)}
        aria-valuenow={clampToSafeNumber(available)}
        aria-valuetext={`${available.toString()} of ${total.toString()}`}
        className={cn(
          'shadow-border relative h-3 overflow-hidden rounded-full bg-ink/5',
          pulse && 'animate-rebal-pulse'
        )}
      >
        {/* Allocated segment (deepest) */}
        <div
          className="absolute left-0 top-0 h-full bg-type-mill"
          style={{ width: `${allocPct}%` }}
          aria-hidden="true"
        />
        {/* In-active-swaps segment (middle) */}
        <div
          className="absolute top-0 h-full bg-ink/40"
          style={{ left: `${allocPct}%`, width: `${activePct}%` }}
          aria-hidden="true"
        />
        {/* Available segment (lightest) */}
        <div
          className="absolute top-0 h-full bg-ink/10"
          style={{ left: `${allocPct + activePct}%`, width: `${availPct}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="flex items-baseline justify-between" aria-hidden="true">
        <span className="font-geist-sans text-xs text-ink/50">
          {chainLabel} · {assetCode}
        </span>
        <span className="font-geist-mono text-xs tabular-nums text-ink/70">
          {available.toString()}/{total.toString()}
        </span>
      </div>
    </div>
  );
}

LiquidityBar.displayName = 'LiquidityBar';
