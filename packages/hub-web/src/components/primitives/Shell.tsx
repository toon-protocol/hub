import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ShellProps {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Shell — top-level layout container.
 * Uses shadow-border instead of CSS border declarations (D21-008 rule).
 */
export function Shell({ header, footer, children, className }: ShellProps) {
  return (
    <div
      className={cn(
        'min-h-screen flex flex-col bg-canvas text-ink font-geist-sans',
        className
      )}
    >
      {header && (
        <header className="shadow-border sticky top-0 z-10 bg-canvas px-6 py-4">
          {header}
        </header>
      )}
      <main className="flex-1 px-6 py-6">{children}</main>
      {footer && (
        <footer className="shadow-border bg-canvas px-6 py-4 text-sm text-ink/60">
          {footer}
        </footer>
      )}
    </div>
  );
}

Shell.displayName = 'Shell';
