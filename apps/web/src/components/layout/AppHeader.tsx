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
            {/*
            The separator is markup, not vocabulary.

            `brand.rest` held `"-Sonic"` while this span rendered its own `-` in front of it,
            so the header read `Edge--Sonic`. Nothing could have caught it: the bundle had one
            well-formed key with one well-formed value, the inline default said `"Sonic"` and
            matched what the author meant, and the rendered string is only wrong to somebody who
            already knows the product is called "Edge-Sonic". `scripts/validate_locales.mjs` now
            compares every inline default against the bundle, which is the check that makes the
            next one of these fail the build instead of the review.
          */}
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
            <NavLink
              to="/import"
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-1.5 transition-colors',
                  isActive
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
                )
              }
            >
              {t('nav.import', 'Import')}
            </NavLink>
          </nav>
        )}
        {/*
          The identity chip is gated on a session, exactly as the nav is, and for the same
          reason. It used to render the email, or the literal word "Operator" when there was no email
          — unconditional, with a **fallback string** — so every signed-out visitor saw
          "Operator" in the top right of the landing page. That is a claim about who is
          looking, rendered for somebody who is not signed in and has no email to show. A chip
          that says "Operator" to an anonymous visitor is the page asserting an identity it does
          not have.

          Gated on `signedIn === true` rather than on `userEmail !== null` for the reason the nav
          is: while `/user/me` is in flight both are null, and the email test would be right for
          the wrong reason on a frame the router is already covering with a spinner. There is no
          third state to render here either — a signed-in operator always has an email, or
          `/user/me` did not authenticate them.
        */}
        {signedIn === true && <span className="ml-auto max-w-xs truncate text-xs text-[var(--color-text-muted)]">{userEmail}</span>}
      </div>
    </header>
  );
}

export { AppHeader };
export default AppHeader;
