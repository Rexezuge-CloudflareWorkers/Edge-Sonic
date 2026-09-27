import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const cardVariants = cva('rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5');

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

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...rest }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...rest} />;
}

function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(cardVariants(), className)} {...rest} />;
}

function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex items-center justify-between gap-3', className)} {...rest} />;
}

function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold text-[var(--color-text-primary)]', className)} {...rest} />;
}

function PageState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-10 text-center">
      {icon}
      <p className="text-sm font-medium text-[var(--color-text-primary)]">{title}</p>
      {description !== undefined && <p className="max-w-md text-xs text-[var(--color-text-muted)]">{description}</p>}
      {action}
    </div>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex items-center justify-center py-10">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-surface-4)] border-t-[var(--color-accent)]" />
    </div>
  );
}

export { Card, CardHeader, CardTitle, Badge, PageState, LoadingSpinner, cardVariants, badgeVariants };
export type { BadgeProps };
