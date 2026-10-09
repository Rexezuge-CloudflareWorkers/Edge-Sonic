import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Form controls. One shared class string rather than four copies of it: a
 * placeholder colour that matches an input but not its `Select` is a difference
 * nobody notices until a client is looking at both.
 */
const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] transition-colors duration-150 focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60';

function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...rest} />;
}

function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClass, className)} {...rest} />;
}

/**
 * `htmlFor` is stated rather than spread, because a label with no `for` is
 * announced by a screen reader as unassociated text: the click target and the
 * accessible name both depend on it, and neither is visible in the markup that
 * omits it.
 */
function Label({
  children,
  htmlFor,
  ...rest
}: { children: ReactNode; htmlFor?: string } & Omit<LabelHTMLAttributes<HTMLLabelElement>, 'htmlFor'>) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]" {...rest}>
      {children}
    </label>
  );
}

function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldClass, 'min-h-20 resize-y', className)} {...rest} />;
}

export { Input, Select, Label, Textarea, fieldClass };
