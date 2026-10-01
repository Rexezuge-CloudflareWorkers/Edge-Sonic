/**
 * SPA composition root.
 *
 * Deliberately tiny: the hook slices (`useCurrentUser`, `useSpaLanguage`,
 * `useNotice`), the header and notice chrome, and the route switch. No data
 * fetching lives here and none lives in the router either — each view owns its
 * own loading, so the shell never decides what "ready" means for content it
 * cannot see.
 */
import { useEffect } from 'react';
import { AppHeader } from './components/layout/AppHeader';
import { NoticeBar } from './components/layout/NoticeBar';
import { SpaViewRouter } from './components/layout/SpaViewRouter';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useNotice } from './hooks/useNotice';
import { useSpaLanguage } from './hooks/useSpaLanguage';
import { clearSignInAttempt } from './lib/signInLoop';

function SpaApp() {
  const { notice, showNotice, clearNotice } = useNotice();
  const { user, setUser, authorized } = useCurrentUser();

  // Cleared once a session exists, so a later expiry is an ordinary signed-out visit
  // rather than a page claiming the Access configuration is broken. In an effect rather
  // than during render because `clearSignInAttempt` touches `sessionStorage` — a read
  // during render is the kind of side effect that makes a component unsafe to render
  // twice, and the value it would read is not needed until after commit anyway.
  useEffect(() => {
    if (authorized === true) clearSignInAttempt();
  }, [authorized]);
  // Return value intentionally unused: with a single locale there is no
  // selector to wire, but the slice still owns detection precedence and the
  // `<html lang>` sync — the shape a second locale plugs into, not a rewrite.
  useSpaLanguage({ user, showNotice, setUser });

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      {/*
        The header renders before the session resolves, and `signedIn` is therefore
        `false` for those frames — which is why it takes `authorized !== null` rather
        than `authorized === true`. See the nav note in `AppHeader`: `userEmail`
        alone cannot tell "still loading" from "signed out", and a signed-in operator
        getting a flash of chrome-free header on every load is worse than a signed-out
        visitor seeing links that lead to a sign-in gate.
      */}
      <AppHeader userEmail={user?.email ?? null} signedIn={authorized} />
      {notice !== null && <NoticeBar notice={notice} onDismiss={clearNotice} />}
      <SpaViewRouter authorized={authorized} showNotice={showNotice} />
    </div>
  );
}

export { SpaApp };
export default SpaApp;