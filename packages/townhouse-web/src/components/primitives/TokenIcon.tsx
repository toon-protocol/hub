import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TokenIconProps {
  token: 'USDC' | 'ETH' | 'SOL' | 'MINA';
  size?: number;
  className?: string;
  'aria-label'?: string;
}

const TOKEN_LETTERS: Record<TokenIconProps['token'], string> = {
  USDC: 'U',
  ETH: 'E',
  SOL: 'S',
  MINA: 'M',
};

/** Circle-with-letter monogram. aria-hidden by default. */
export function TokenIcon({ token, size = 14, className, 'aria-label': ariaLabel }: TokenIconProps) {
  const hidden = !ariaLabel;
  const letter = TOKEN_LETTERS[token];
  const fontSize = Math.round(size * 0.5);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('inline-block flex-shrink-0', className)}
      aria-hidden={hidden || undefined}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2" />
      <text
        x="8"
        y="8"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fill="currentColor"
        fontFamily="Geist Mono, monospace"
        fontWeight="600"
      >
        {letter}
      </text>
    </svg>
  );
}

TokenIcon.displayName = 'TokenIcon';
