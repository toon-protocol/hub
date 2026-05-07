import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-md font-geist-sans font-medium',
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: 'shadow-border bg-ink text-canvas hover:bg-ink/90 focus-visible:ring-ink',
        secondary: 'shadow-border bg-canvas text-ink hover:bg-ink/5 focus-visible:ring-ink',
        ghost: 'text-ink hover:bg-ink/5 focus-visible:ring-ink',
      },
      size: {
        sm: 'h-8 px-3 text-xs tracking-tight-14',
        md: 'h-9 px-4 text-sm tracking-tight-14',
        lg: 'h-11 px-6 text-base tracking-tight-16',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      aria-busy={loading}
      {...props}
    >
      {loading && (
        <svg
          className="h-3.5 w-3.5 animate-spin"
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
      )}
      {children}
    </button>
  );
}

Button.displayName = 'Button';

export { buttonVariants };
