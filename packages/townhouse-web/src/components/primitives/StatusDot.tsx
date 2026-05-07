import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const statusDotVariants = cva('inline-block rounded-full flex-shrink-0', {
  variants: {
    state: {
      ok: 'bg-green-500',
      degraded: 'bg-yellow-400',
      down: 'bg-red-500',
      unknown: 'bg-ink/20',
    },
    size: {
      sm: 'h-2 w-2',
      md: 'h-2.5 w-2.5',
      lg: 'h-3 w-3',
    },
  },
  defaultVariants: {
    state: 'unknown',
    size: 'md',
  },
});

const stateLabels: Record<NonNullable<StatusDotProps['state']>, string> = {
  ok: 'Online',
  degraded: 'Degraded',
  down: 'Offline',
  unknown: 'Unknown',
};

export interface StatusDotProps extends VariantProps<typeof statusDotVariants> {
  className?: string;
  /** aria-label is required — enforced by axe-core test */
  'aria-label'?: string;
}

/**
 * StatusDot — small graphic indicator. Uses role="img" (not "status") so
 * multiple dots on the same view don't fight as competing live regions.
 * If a caller needs live-region announcements, wrap a region in their own
 * role="status" container.
 */
export function StatusDot({ state, size, className, 'aria-label': ariaLabel }: StatusDotProps) {
  const resolvedLabel = ariaLabel ?? `Status: ${stateLabels[state ?? 'unknown']}`;
  return (
    <span
      role="img"
      aria-label={resolvedLabel}
      className={cn(statusDotVariants({ state, size }), className)}
    />
  );
}

StatusDot.displayName = 'StatusDot';
