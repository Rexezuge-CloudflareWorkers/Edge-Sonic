import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Disc3 } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Top navigation.
 *
 * Global rather than root-only, unlike the reference project: that one is
 * root-only because every other route renders a contextual `ContextBar` instead,
 * and this surface has two sibling routes with no hierarchy between them —
 * hiding the header would leave `/libraries` with no way back.
 *
 * `NavLink` rather than `Link` so the active route is marked with `aria-current`,
 * which is what a screen reader announces — a purely visual active state is
 * invisible to it.
 */
function AppHeader({ userEmail, signedIn }: { userEmail?: string | null; signedIn: boolean | null }) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Disc3 className="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
          <span>
            <span className="text-[var(--color-accent)]">{t('brand.accent', 'Edge')}</span>
            <span>-{t('brand.rest', 'Sonic')}</span>
          </span>
        </Link>
        {/*
          The nav is for a session, so it renders only for one. A signed-out visitor
          who could click "Libraries" would land on the `Unauthorized` gate — two
          dead links advertising a surface they cannot reach, which is worse than no
          navigation at all.

          `authorized === true` and not `userEmail !== null`, because those differ in
          two directions and only one of them is a gate. While `/user/me` is in flight
          `userEmail` is `null` and the nav would flash off for a signed-in operator —
          harmless, since the router is showing a full-screen spinner for those frames
          anyway. Once it answers, `userEmail` and `authorized` agree, so the honest
          test is the one that is *false* on a known denial rather than the one that is
          merely `null` on a pending read.
        */}
        {signedIn === true && (
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
        )}
        <span className="ml-auto max-w-xs truncate text-xs text-[var(--color-text-muted)]">
          {userEmail ?? t('nav.operator', 'Operator')}
        </span>
      </div>
    </header>
  );
}

export { AppHeader };
export default AppHeader;