import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Disc3 } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Top navigation.
 *
 * Always rendered, on every route: the operator surface is two lists, not a
 * marketing page with a contextual bar, so there is no second header to swap
 * in. `userEmail` is the session slice from the shell — the address when `/me`
 * has answered, falling back to the static operator label while it has not.
 *
 * `NavLink` rather than `Link` so the active route is marked with `aria-current`,
 * which is what a screen reader announces — a purely visual active state is
 * invisible to it.
 */
function AppHeader({ userEmail }: { userEmail?: string | null }) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Disc3 className="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
          <span>
            <span className="text-[var(--color-accent)]">{t('brand.accent', 'Edge')}</span>
            <span>{t('brand.rest', '-Sonic')}</span>
          </span>
        </span>
        <nav className="flex items-center gap-1 text-sm" aria-label={t('nav.label', 'Primary')}>
          <NavLink
            to="/libraries"
            className={({ isActive }) =>
              cn(
                'rounded-md px-3 py-1.5 transition-colors',
                isActive
                  ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
              )
            }
          >
            {t('nav.libraries', 'Libraries')}
          </NavLink>
          <NavLink
            to="/users"
            className={({ isActive }) =>
              cn(
                'rounded-md px-3 py-1.5 transition-colors',
                isActive
                  ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
              )
            }
          >
            {t('nav.users', 'Users')}
          </NavLink>
        </nav>
        <span className="ml-auto max-w-xs truncate text-xs text-[var(--color-text-muted)]">
          {userEmail ?? t('nav.operator', 'Operator')}
        </span>
      </div>
    </header>
  );
}

export { AppHeader };
export default AppHeader;
