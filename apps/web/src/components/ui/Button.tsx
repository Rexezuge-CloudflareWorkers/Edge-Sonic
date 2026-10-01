import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * The one button.
 *
 * `lg` exists for the landing hero's single call to action and nothing else: it is
 * the only place on this surface where a control is the primary thing on the page
 * rather than one of a row of them, and a variant with one call site is a variant
 * that will not stay at one.
 *
 * `type` is defaulted to `button` rather than left to the HTML default, because a
 * `<button>` inside a `<form>` with no `type` **submits**, and every form on this
 * surface has a submit button of its own.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--color-accent)] text-[#0d1008] hover:bg-[var(--color-accent-dim)]',
        secondary: 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-4)]',
        ghost: 'bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
        danger: 'bg-[var(--color-error-bg)] text-[var(--color-error-text)] hover:opacity-90',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-base',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { loading?: boolean };

function Button({ className, variant, size, loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };