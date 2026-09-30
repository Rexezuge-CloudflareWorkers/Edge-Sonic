import { useTranslation } from 'react-i18next';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../../lib/constants';

function authenticateWithZeroTrust() {
  globalThis.location.assign(ZERO_TRUST_AUTHENTICATION_PATH);
}

/**
 * What renders when the operator is not authenticated.
 *
 * Not wired into the router yet on purpose: Cloudflare Access enforces the
 * `/user/*` surface at the edge, so a transient `GET /user/me` failure must not
 * become a client-side lockout — the views already render an empty list plus a
 * notice when the API is unreachable. This exists for the day a route needs an
 * explicit gate rather than the edge's implicit one.
 */
export default function Unauthorized({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-[var(--color-surface-base)] text-[var(--color-text-primary)] flex items-center justify-center py-16">
      <div className="text-center px-6">
        <h1 className="text-lg font-medium mt-4 mb-1">{t('unauthorized.title', 'Access required')}</h1>
        <p className="text-[var(--color-text-secondary)] text-sm">
          {message ?? t('unauthorized.defaultMessage', 'You must authenticate to access this page.')}
        </p>
        <button
          type="button"
          onClick={authenticateWithZeroTrust}
          className="mt-6 inline-flex items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-[#0d1008] transition-colors hover:bg-[var(--color-accent-dim)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          {t('unauthorized.action', 'Sign in with Cloudflare Access')}
        </button>
      </div>
    </div>
  );
}
