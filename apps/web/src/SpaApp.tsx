/**
 * SPA composition root.
 *
 * Deliberately tiny: the hook slices (`useCurrentUser`, `useSpaLanguage`,
 * `useNotice`), the header and notice chrome, and the route switch. No data
 * fetching lives here and none lives in the router either — each view owns its
 * own loading, so the shell never decides what "ready" means for content it
 * cannot see.
 */
import { AppHeader } from './components/layout/AppHeader';
import { NoticeBar } from './components/layout/NoticeBar';
import { SpaViewRouter } from './components/layout/SpaViewRouter';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useNotice } from './hooks/useNotice';
import { useSpaLanguage } from './hooks/useSpaLanguage';

function SpaApp() {
  const { notice, showNotice, clearNotice } = useNotice();
  const { user, setUser } = useCurrentUser();
  // Return value intentionally unused: with a single locale there is no
  // selector to wire, but the slice still owns detection precedence and the
  // `<html lang>` sync — the shape a second locale plugs into, not a rewrite.
  useSpaLanguage({ user, showNotice, setUser });

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      <AppHeader userEmail={user?.email ?? null} />
      {notice !== null && <NoticeBar notice={notice} onDismiss={clearNotice} />}
      <SpaViewRouter showNotice={showNotice} />
    </div>
  );
}

export { SpaApp };
export default SpaApp;
