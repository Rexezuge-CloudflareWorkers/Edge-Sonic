/**
 * SPA composition root.
 *
 * Deliberately tiny. The reference project this was scaffolded from had a 40-module
 * front end; the operator surface here is two lists and two forms, so the app is
 * composed from a notice hook, a router, and the two views. Growing it is fine —
 * adding a *framework* to it is not.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { useNotice } from './hooks/useNotice';
import { AppHeader } from './components/layout/AppHeader';
import { NoticeBar } from './components/layout/NoticeBar';
import { LibrariesView } from './views/LibrariesView';
import { UsersView } from './views/UsersView';

function SpaApp() {
  const { notice, showNotice, clearNotice } = useNotice();

  return (
    <div className="min-h-screen">
      <AppHeader />
      {notice !== null && <NoticeBar notice={notice} onDismiss={clearNotice} />}
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<LibrariesView showNotice={showNotice} />} />
          <Route path="/libraries" element={<LibrariesView showNotice={showNotice} />} />
          <Route path="/users" element={<UsersView showNotice={showNotice} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export { SpaApp };
export default SpaApp;
