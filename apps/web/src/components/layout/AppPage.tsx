import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

type AppPageVariant = 'wide' | 'narrow' | 'hero';

/**
 * Single standardized page container. `wide` is the default for every view;
 * `narrow` is reserved for centered forms; `hero` is reserved for a landing
 * hero. Keeps left-edge alignment identical across page changes.
 *
 * `wide` is `max-w-5xl`, not the reference project's `max-w-7xl`: the operator
 * surface is two lists and two forms, and the wider measure only adds line
 * length to prose that is already at its readable limit.
 */
export function AppPage({ variant = 'wide', className, children }: { variant?: AppPageVariant; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-6',
        variant === 'wide' && 'max-w-5xl py-8 space-y-4',
        variant === 'narrow' && 'max-w-2xl py-8 space-y-4',
        variant === 'hero' && 'max-w-5xl py-16',
        className,
      )}
    >
      {children}
    </div>
  );
}
