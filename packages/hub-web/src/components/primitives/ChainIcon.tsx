import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ChainIconProps {
  chain: 'evm' | 'solana' | 'mina';
  size?: number;
  className?: string;
  'aria-label'?: string;
}

/** Inline SVG glyph per chain family. aria-hidden by default. */
export function ChainIcon({ chain, size = 14, className, 'aria-label': ariaLabel }: ChainIconProps) {
  const hidden = !ariaLabel;
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    className: cn('inline-block flex-shrink-0', className),
    'aria-hidden': hidden || undefined,
    'aria-label': ariaLabel,
    role: ariaLabel ? 'img' : undefined,
  };

  if (chain === 'evm') {
    return (
      <svg {...props}>
        {/* Ethereum diamond */}
        <polygon points="8,1 14.5,8 8,11.5 1.5,8" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points="8,11.5 14.5,8 8,15" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }

  if (chain === 'solana') {
    return (
      <svg {...props}>
        {/* Solana three-band stripes */}
        <rect x="2" y="3.5" width="12" height="2.2" rx="1" fill="currentColor" />
        <rect x="2" y="6.9" width="12" height="2.2" rx="1" fill="currentColor" />
        <rect x="2" y="10.3" width="12" height="2.2" rx="1" fill="currentColor" />
      </svg>
    );
  }

  // mina
  return (
    <svg {...props}>
      {/* Mina hexagon */}
      <polygon points="8,1.5 13.5,4.75 13.5,11.25 8,14.5 2.5,11.25 2.5,4.75" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

ChainIcon.displayName = 'ChainIcon';
