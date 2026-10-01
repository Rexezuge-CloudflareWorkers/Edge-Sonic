import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The two states every list on this surface passes through, so they render at the
 * same geometry everywhere.
 *
 * Both are in one file because they are one decision — what a page looks like when
 * it has nothing to show yet — and a `LoadingSpinner` imported from
 * `layout/PageState` says that, while one imported from `ui/Spinner` next to a
 * `Badge` does not.
 */

/**
 * `role="status"` so the wait is announced rather than being a silent gap, and the
 * label is passed in rather than defaulted: "Loading libraries" and "Loading users"
 * are different facts, and a shared "Loading…" tells a screen-reader user which of
 * two pages they are on only by what they asked for.
 */
function LoadingSpinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  const resolved = label ?? t('common.loading', 'Loading…');
  return (
    <div role="status" aria-label={resolved} className="flex min-h-64 items-center justify-center">
      <span className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
    </div>
  );
}

/**
 * The empty case.
 *
 * `title` is the claim and `description` is what to do about it, and they are
 * separate props rather than one `message` because they are read at different
 * moments: the title tells an operator whether anything is wrong, the description
 * tells them what their next action is. `description` is optional — an empty list
 * on a page with no next action should not invite one.
 */
function EmptyState({ icon, title, description }: { icon?: ReactNode; title: string; description?: string }) {
  return (
    <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">
      {icon && <div className="mb-3 flex justify-center">{icon}</div>}
      <p className="font-medium text-[var(--color-text-primary)]">{title}</p>
      {description !== undefined && <p className="mx-auto mt-1 max-w-md text-xs">{description}</p>}
    </div>
  );
}

export { LoadingSpinner, EmptyState };