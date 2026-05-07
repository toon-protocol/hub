import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const typeChipVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-geist-mono font-medium uppercase tracking-wider',
  {
    variants: {
      type: {
        town: 'bg-type-town/10 text-type-town',
        mill: 'bg-type-mill/10 text-type-mill',
        dvm: 'bg-type-dvm/10 text-type-dvm',
      },
    },
    defaultVariants: {
      type: 'town',
    },
  }
);

const typeLabels: Record<NonNullable<TypeChipProps['type']>, string> = {
  town: 'Town',
  mill: 'Mill',
  dvm: 'DVM',
};

export interface TypeChipProps extends VariantProps<typeof typeChipVariants> {
  className?: string;
}

/**
 * TypeChip — node-type accent label. Visible text IS the accessible content
 * (no aria-label override) so screen readers and voice-control match what
 * sighted users see. The visual styling supplies the type semantics.
 */
export function TypeChip({ type, className }: TypeChipProps) {
  const label = typeLabels[type ?? 'town'];
  return <span className={cn(typeChipVariants({ type }), className)}>{label}</span>;
}

TypeChip.displayName = 'TypeChip';
