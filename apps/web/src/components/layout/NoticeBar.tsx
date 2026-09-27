import { X } from 'lucide-react';
import type { Notice } from '../../types';

/**
 * A dismissible status banner.
 *
 * `role="status"` with `aria-live="polite"` so a message that appears after an
 * async action is announced rather than silently swapping the page under the user.
 * An error gets `role="alert"` instead, which interrupts — appropriate, because an
 * error is the one thing the user must not miss.
 */
function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const isError = notice.type === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={[
        'fixed inset-x-0 top-16 z-20 mx-auto flex w-full max-w-2xl items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg',
        isError
          ? 'border-[var(--color-error-border,var(--color-border))] bg-[var(--color-error-bg)] text-[var(--color-error-text)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-primary)]',
      ].join(' ')}
    >
      <span className="flex-1">{notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export { NoticeBar };
export default NoticeBar;
