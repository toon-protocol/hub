import * as React from 'react';
import { cn } from '@/lib/utils';

export type ShellState = 'ready' | 'loading' | 'empty' | 'error';

export interface StateShellProps {
  state: ShellState;
  children?: React.ReactNode;
  loadingSlot?: React.ReactNode;
  emptySlot?: React.ReactNode;
  errorSlot?: React.ReactNode;
  className?: string;
}

const defaultSlots: Record<ShellState, React.ReactNode> = {
  ready: null,
  loading: (
    <div
      className="flex items-center justify-center py-12"
      role="status"
      aria-label="Loading"
      aria-busy="true"
    >
      <svg
        className="h-6 w-6 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12" cy="12" r="10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="31.4 31.4"
        />
      </svg>
    </div>
  ),
  empty: (
    <div className="flex flex-col items-center justify-center py-12 text-ink/40" role="status">
      <span className="text-4xl mb-3" aria-hidden="true">○</span>
      <p className="text-sm">Nothing here yet</p>
    </div>
  ),
  error: (
    <div className="flex flex-col items-center justify-center py-12 text-red-500" role="alert">
      <span className="text-4xl mb-3" aria-hidden="true">!</span>
      <p className="text-sm">Something went wrong</p>
    </div>
  ),
};

/**
 * StateShell — wraps content with loading/empty/error/ready state rendering.
 * The `className` prop is applied to a wrapper div in every state, so callers
 * can style spacing/sizing consistently regardless of which slot is active.
 */
export function StateShell({
  state,
  children,
  loadingSlot,
  emptySlot,
  errorSlot,
  className,
}: StateShellProps) {
  let content: React.ReactNode;
  if (state === 'loading') content = loadingSlot ?? defaultSlots.loading;
  else if (state === 'empty') content = emptySlot ?? defaultSlots.empty;
  else if (state === 'error') content = errorSlot ?? defaultSlots.error;
  else content = children;

  return <div className={cn(className)}>{content}</div>;
}

StateShell.displayName = 'StateShell';
