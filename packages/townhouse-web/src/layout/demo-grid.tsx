/**
 * DemoGrid — the 50/50 split layout primitive used by the demo dashboard
 * (Story D9, AC-D9-2 / AC-D9-5).
 *
 * Caravaggio's split-screen money shot: Ditto on the left, ops panels on
 * the right. The grid is a fixed two-column layout (1fr 1fr) at the
 * demo-day viewport (1440x900). Both halves get the full available
 * height; the page itself does not scroll — overflow is delegated to the
 * children (right-column components scroll inside their own boxes per
 * AC-D9-3).
 *
 * Below 1024px the split collapses to a single column (left first, right
 * stacked underneath) so the layout doesn't degenerate on smaller dev
 * machines, but the demo viewport assumption is 1440x900.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface DemoGridProps {
  /** Left half — Ditto iframe in production. */
  left: React.ReactNode;
  /** Right half — single-column stack of ops panels. */
  right: React.ReactNode;
  className?: string;
}

/**
 * Renders a single-row grid with two equal columns (50/50). The grid
 * fills the available height of its parent and does not introduce any
 * scroll itself — overflow is delegated to the slot children.
 */
export function DemoGrid({ left, right, className }: DemoGridProps) {
  return (
    <div
      data-testid="demo-grid"
      className={cn(
        // 50/50 split at >=lg, single column below.
        'grid h-full min-h-0 w-full grid-cols-1 gap-4 lg:grid-cols-2',
        className
      )}
    >
      <section
        aria-label="Ditto client"
        // min-h-0 is the magic that lets a grid child's overflow work.
        // Without it, an iframe at 100% height would force the grid taller.
        className="min-h-0 min-w-0"
      >
        {left}
      </section>
      <section
        aria-label="Operator ops panels"
        // The right column is a single-column stack; children scroll
        // inside their own containers, not the column itself.
        className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden"
      >
        {right}
      </section>
    </div>
  );
}

DemoGrid.displayName = 'DemoGrid';
