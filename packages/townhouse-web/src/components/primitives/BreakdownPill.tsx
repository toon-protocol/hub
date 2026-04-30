import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BreakdownSegment {
  label: string;
  value: string;
  tone?: 'positive' | 'neutral' | 'negative';
}

export interface BreakdownPillProps {
  segments: BreakdownSegment[];
  className?: string;
}

const TONE_CLASSES = {
  positive: 'text-green-600/80',
  negative: 'text-red-500/80',
  neutral: 'text-ink',
} as const;

/**
 * BreakdownPill — displays multiple label:value segments inline in a
 * shadow-bordered pill. Tones tint the value text.
 */
export function BreakdownPill({ segments, className }: BreakdownPillProps) {
  const ariaLabel = segments.map((s) => `${s.label}: ${s.value}`).join(', ');

  return (
    <div
      className={cn(
        'shadow-border inline-flex items-center gap-2 rounded-full px-3 py-1',
        className
      )}
      aria-label={ariaLabel}
    >
      {segments.map((seg, i) => (
        // Index is used as the key because labels can repeat across segments
        // (e.g. two `Net` rows during error fallback).
        <React.Fragment key={i}>
          {i > 0 && (
            <span
              className="font-geist-mono text-xs text-ink/40"
              aria-hidden="true"
            >
              ·
            </span>
          )}
          <span className="font-geist-sans text-xs text-ink/70">{seg.label}</span>
          <code
            className={cn(
              'font-geist-mono text-xs',
              TONE_CLASSES[seg.tone ?? 'neutral']
            )}
          >
            {seg.value}
          </code>
        </React.Fragment>
      ))}
    </div>
  );
}
