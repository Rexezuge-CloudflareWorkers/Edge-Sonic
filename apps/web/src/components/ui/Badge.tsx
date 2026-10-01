import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * Status tone, and only status tone.
 *
 * `neutral` is the default rather than a required choice, and it is the right
 * default for a badge whose verdict is not yet known: `describeProbe` returns
 * `neutral` for the in-flight state, and a badge that renders nothing at all while
 * it cannot say which it is reads as "there is no verdict" — which is a different
 * answer from "the verdict is neutral".
 */
const badgeVariants = cva('inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      neutral: 'bg-[var(--color-neutral-bg)] text-[var(--color-neutral-text)]',
      success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
      warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
      error: 'bg-[var(--color-error-bg)] text-[var(--color-error-text)]',
      info: 'bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...rest }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...rest} />;
}

export { Badge, badgeVariants };
export type { BadgeProps };