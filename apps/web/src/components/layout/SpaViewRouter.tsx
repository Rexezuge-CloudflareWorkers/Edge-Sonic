import { Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ShowNotice } from '../../hooks/useNotice';
import { AppPage } from './AppPage';
import { Card } from '../ui/Card';
import Unauthorized from './Unauthorized';
import { LandingView } from '../../views/LandingView';
import { LibrariesView } from '../../views/LibrariesView';
import { UsersView } from '../../views/UsersView';

interface SpaViewRouterProps {
  /**
   * `null` while `/user/me` is in flight, then the verdict.
   *
   * The router takes this and **not** the `CurrentUser` beside it, because `authorized`
   * is the one that decides what renders and `user` cannot contradict it: `true` is set
   * in the same `setState` batch as the user, so there is no state in which the router
   * has an identity and no verdict. Passing both would be a second way to ask the same
   * question, and the one that can disagree.
   */
  authorized: boolean | null;
  showNotice: ShowNotice;
}

/**
 * A full-page spinner for a session that has not resolved yet.
 *
 * Shared by both branches below so the two cannot drift into different spinners —
 * and it is a spinner rather than the view because a signed-in operator who sees
 * `LibrariesView` for 80 ms and then the same view again has been shown the
 * page twice, which is what makes a resolving state worth hiding.
 */
function SessionResolving() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-surface-base)]">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" role="status" aria-label="Loading" />
    </div>
  );
}

/**
 * Route switch extracted from `SpaApp` so the shell stays a thin composition
 * root. Props are the already-composed hook slices; no data fetching here.
 *
 * ### `authorized` is three states, and two of them gate differently
 *
 * `null` means `/user/me` has not answered. Every route renders on a spinner,
 * because the alternative is to show a signed-in operator the signed-out page for
 * the length of one request.
 *
 * `false` means it answered and refused. That is the only state that gates, and it
 * gates because **the SPA shell is public**: `EdgeSonicWorker` serves `SPA_HTML`
 * for `/`, `/libraries` and `/users` before the auth middleware runs, because a
 * browser navigating to a client-side route sends no API call for the worker to
 * authenticate. Without this branch, `LibrariesView` would call `/user/libraries`,
 * take the 401, and render its documented "empty list plus a notice" — the
 * honest-looking answer to "you have no libraries", for a caller who cannot have
 * any.
 *
 * The gate is a courtesy, not a control: `/user/*` is independently guarded by
 * `userAuthentication`, so nothing is readable by ignoring this component.
 *
 * Note what the *view* still does with a failure it cannot classify: a 401 raised
 * after this branch — an expired session mid-use, say — still renders as an empty
 * list plus a notice. That path is reachable and this component does not cover it,
 * because distinguishing it needs the API to say *why* it refused, which it will
 * not do for an unauthenticated caller. See `LandingView`'s note on the same
 * limit.
 */
function SpaViewRouter({ authorized, showNotice }: SpaViewRouterProps) {
  const { t } = useTranslation();

  if (authorized === null) {
    return <SessionResolving />;
  }

  const signedOut = !authorized;
  const page = (children: React.ReactNode) => <AppPage>{children}</AppPage>;

  return (
    <Routes>
      <Route path="/" element={signedOut ? <LandingView /> : page(<LibrariesView showNotice={showNotice} />)} />
      <Route
        path="/libraries"
        element={
          signedOut ? (
            page(<Unauthorized message={t('errors.signInToViewLibraries', 'Sign in to view libraries.')} />)
          ) : (
            page(<LibrariesView showNotice={showNotice} />)
          )
        }
      />
      <Route
        path="/users"
        element={signedOut ? page(<Unauthorized message={t('errors.signInToViewUsers', 'Sign in to view users.')} />) : page(<UsersView showNotice={showNotice} />)}
      />
      <Route
        path="*"
        element={
          page(
            <Card>
              <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('errors.pageNotFound', 'Page not found')}</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t('errors.pageNotFoundDescription', 'The page you requested does not exist.')}
              </p>
            </Card>,
          )
        }
      />
    </Routes>
  );
}

export { SpaViewRouter, SessionResolving };
export type { SpaViewRouterProps };