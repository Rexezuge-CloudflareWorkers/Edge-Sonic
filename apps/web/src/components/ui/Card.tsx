import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Surface primitives. One component per file, so a change to `Card` cannot
 * arrive in a diff that claims to be about `Badge`.
 *
 * The props spread through to the DOM element, which the reference's `Card` does
 * not do: `className` alone cannot carry `id` or `role`, and a card that has to be
 * an `<section aria-labelledby>` should not need a wrapper element to say so.
 */

const cardVariants = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5';

function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(cardVariants, className)} {...rest} />;
}

function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex items-center justify-between gap-3', className)} {...rest} />;
}

function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold text-[var(--color-text-primary)]', className)} {...rest} />;
}

export { Card, CardHeader, CardTitle, cardVariants };