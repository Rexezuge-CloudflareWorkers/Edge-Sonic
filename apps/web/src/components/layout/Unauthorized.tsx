import { useTranslation } from 'react-i18next';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../../lib/constants';

function authenticateWithZeroTrust() {
  globalThis.location.assign(ZERO_TRUST_AUTHENTICATION_PATH);
}

/**
 * The signed-out answer for a route that needs a session.
 *
 * `message` is a prop rather than a fixed string because the two gated routes mean
 * different things to a visitor who followed a link here: "you need to sign in to
 * see libraries" is a different sentence from "you need to sign in to see users",
 * and one shared "access required" tells them nothing about what they were trying to
 * reach. The default is for a caller with nothing more specific to say.
 *
 * ### Why this is a client-side gate at all
 *
 * Cloudflare Access enforces this surface at the edge, and `/user/*` is
 * independently guarded by `userAuthentication` — so a signed-out caller cannot read
 * anything by ignoring this component. It is here because **the SPA shell itself is
 * public**: `EdgeSonicWorker` serves `SPA_HTML` for `/`, `/libraries` and `/users`
 * before the auth middleware is installed, because a browser navigating to a
 * client-side route sends no API call for the worker to authenticate.
 *
 * Which means without this component a signed-out visitor deep-linking to
 * `/libraries` gets `LibrariesView`, which calls `/user/libraries`, gets a 401, and
 * renders an **empty list plus a notice** — the honest-looking answer for "you have
 * no libraries". That is the failure this replaces: a wrong answer the operator
 * cannot distinguish from the truth.
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
