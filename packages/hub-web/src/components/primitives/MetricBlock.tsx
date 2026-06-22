import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const metricBlockVariants = cva('flex flex-col', {
  variants: {
    variant: {
      full: 'gap-1',
      compact: 'gap-0.5',
    },
  },
  defaultVariants: {
    variant: 'full',
  },
});

export interface MetricBlockProps extends VariantProps<typeof metricBlockVariants> {
  value: number | string;
  label: string;
  unit?: string;
  /** Positive = up, negative = down. NaN/Infinity is treated as "no trend". */
  trend?: number;
  className?: string;
  /**
   * Override the auto-generated accessible name. Useful for unavailable-data
   * states where `"<label>: —"` would read as gibberish ("Events today em-dash"),
   * e.g. `aria-label="metric unavailable"`.
   */
  'aria-label'?: string;
}

/**
 * MetricBlock — number + label + optional unit + optional trend indicator.
 * tnum applied to digits (tabular numerals). NOT a sparkline.
 */
export function MetricBlock({
  value,
  label,
  unit,
  trend,
  variant,
  className,
  'aria-label': ariaLabelOverride,
}: MetricBlockProps) {
  const hasTrend = trend !== undefined && Number.isFinite(trend) && trend !== 0;
  const isPositive = hasTrend && (trend as number) > 0;
  const isNegative = hasTrend && (trend as number) < 0;

  const trendText = hasTrend ? `${isPositive ? '+' : ''}${trend}` : '';
  const accessibleName =
    ariaLabelOverride ??
    [
      `${label}: ${value}`,
      unit ? ` ${unit}` : '',
      hasTrend ? ` (trend ${trendText})` : '',
    ].join('');

  return (
    <div
      className={cn(metricBlockVariants({ variant }), className)}
      role="group"
      aria-label={accessibleName}
    >
      <div className="flex items-baseline gap-1.5" aria-hidden="true">
        <span
          className={cn(
            'font-geist-mono tabular-nums font-semibold text-ink',
            variant === 'compact' ? 'text-xl' : 'text-3xl'
          )}
        >
          {value}
        </span>
        {unit && (
          <span className="font-geist-mono text-sm text-ink/50 tabular-nums">{unit}</span>
        )}
        {hasTrend && (
          <span
            className={cn(
              'font-geist-mono text-xs tabular-nums',
              isPositive && 'text-green-600',
              isNegative && 'text-red-500'
            )}
          >
            {trendText}
          </span>
        )}
      </div>
      <span
        className={cn(
          'font-geist-sans text-ink/60',
          variant === 'compact' ? 'text-xs' : 'text-sm'
        )}
        aria-hidden="true"
      >
        {label}
      </span>
    </div>
  );
}

MetricBlock.displayName = 'MetricBlock';
