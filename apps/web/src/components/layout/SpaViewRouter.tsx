import { Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ShowNotice } from '../../hooks/useNotice';
import { AppPage } from './AppPage';
import { Card } from '../ui/panels';
import { LibrariesView } from '../../views/LibrariesView';
import { UsersView } from '../../views/UsersView';

interface SpaViewRouterProps {
  showNotice: ShowNotice;
}

/**
 * Route switch extracted from `SpaApp` so the shell stays a thin composition
 * root. Props are the already-composed hook slices; no data fetching here.
 *
 * Routes render speculatively on purpose: the views already answer an
 * unreachable user API with an empty list plus a notice, so gating on the
 * session would only turn a transient `/me` failure into a blank page.
 */
function SpaViewRouter({ showNotice }: SpaViewRouterProps) {
  const { t } = useTranslation();
  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppPage>
            <LibrariesView showNotice={showNotice} />
          </AppPage>
        }
      />
      <Route
        path="/libraries"
        element={
          <AppPage>
            <LibrariesView showNotice={showNotice} />
          </AppPage>
        }
      />
      <Route
        path="/users"
        element={
          <AppPage>
            <UsersView showNotice={showNotice} />
          </AppPage>
        }
      />
      <Route
        path="*"
        element={
          <AppPage>
            <Card>
              <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('errors.pageNotFound', 'Page not found')}</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t('errors.pageNotFoundDescription', 'The page you requested does not exist.')}
              </p>
            </Card>
          </AppPage>
        }
      />
    </Routes>
  );
}

export { SpaViewRouter };
export type { SpaViewRouterProps };
