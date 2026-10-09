import { Database, Disc3, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../lib/constants';
import { hasPriorSignInAttempt, rememberSignInAttempt } from '../lib/signInLoop';

/**
 * Navigating to a path inside the Access application is what starts the login flow.
 * `/user/` rather than a login URL: the redirect Access performs comes back to
 * whatever it interrupted, so this is the path whose redirect target the worker can
 * turn into `/` (see `lib/constants.ts`). Hardcoding an Access login endpoint would
 * make the page depend on an Access app's UUID-shaped URL, which is per-deployment
 * and per-account.
 */
function signIn() {
  // Recorded before the navigation, because the navigation ends this page load: by the
  // time the next one runs, only the stored fact says an attempt was made. See
  // `lib/signInLoop.ts` for what the repeat attempt means.
  rememberSignInAttempt();
  globalThis.location.assign(ZERO_TRUST_AUTHENTICATION_PATH);
}

/**
 * What a signed-out visitor sees instead of the operator surface.
 *
 * The hero states what the server *is* rather than what it is for: "WebDAV on the
 * edge" is a claim a reader can check, whereas "your music, everywhere" is not, and
 * a landing page that cannot be verified is a landing page that teaches nothing
 * about whether the thing works.
 *
 * The three cards name the three facts a visitor is actually deciding on — that
 * clients work, that the origin is ordinary WebDAV, and that the UI is behind
 * Access — because those are the three ways this product differs from "run Navidrome
 * somewhere".
 */
export function LandingView() {
  const { t } = useTranslation();
  // True only when a sign-in was already attempted in this browsing session *and* this
  // page is still anonymous. Either fact alone is unremarkable — an attempt that
  // succeeded lands on `/`, and a first visit has no attempt — so it is their
  // conjunction that carries the meaning. The server cannot confirm it (see
  // `lib/signInLoop.ts`), so the sentence names the two variables to check rather than
  // asserting which is wrong.
  const signInDidNothing = hasPriorSignInAttempt();

  return (
    <AppPage variant="hero">
      <div className="text-center max-w-2xl mx-auto animate-fade-in-up">
        <h1 className="text-4xl font-semibold tracking-tight text-[var(--color-text-primary)]">
          {t('landing.title', 'The Subsonic API, Served From A WebDAV Library')}
        </h1>
        <p className="mt-4 text-[var(--color-text-secondary)]">
          {t(
            'landing.subtitle',
            'Point any Subsonic client at this server and browse music you already have on WebDAV. No Transcoding, No Separate Library To Maintain.',
          )}
        </p>
        <div className="mt-8">
          <Button variant="primary" size="lg" onClick={signIn}>
            {t('landing.signIn', 'Sign In With Cloudflare Access')}
          </Button>
        </div>
        {/*
          Muted, not in the error tone, and beside the button rather than replacing it.
          The button is still correct — a deployment whose Access app is mid-rollout
          works on the next click — so an error banner would report a fault that may not
          be there. This is the same reasoning as a scan that stops at a subrequest bound
          being rendered muted rather than red: the chunk did its job, and colouring it as
          a fault trains an operator to ignore the line that does mean something broke.
        */}
        {signInDidNothing && (
          <p className="mx-auto mt-6 max-w-md text-xs text-[var(--color-text-muted)]">
            {t(
              'landing.signInDidNothing',
              'That navigation returned here without a session. Check That A Cloudflare Access Application Covers {{path}}, And That The Worker Has {{aud}} And {{team}} Set.',
              { path: ZERO_TRUST_AUTHENTICATION_PATH, aud: 'POLICY_AUD', team: 'TEAM_DOMAIN' },
            )}
          </p>
        )}
      </div>

      <div className="grid md:grid-cols-3 gap-4 mt-12 animate-stagger-1">
        <Card>
          <Disc3 className="h-5 w-5 text-[var(--color-accent)] mb-3" aria-hidden="true" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">{t('landing.subsonicApi', 'Subsonic API')}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('landing.subsonicApiDescription', 'Full Subsonic 1.16.1. Every Client You Already Have Signs In And Browses.')}
          </p>
        </Card>
        <Card>
          <Globe className="h-5 w-5 text-[var(--color-accent)] mb-3" aria-hidden="true" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">{t('landing.webdavOrigin', 'Any WebDAV Origin')}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('landing.webdavOriginDescription', 'Nextcloud, ownCloud, Or Anything Answering PROPFIND. Your Files Never Leave Home.')}
          </p>
        </Card>
        <Card>
          <Database className="h-5 w-5 text-[var(--color-accent)] mb-3" aria-hidden="true" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">{t('landing.edgeIndex', 'An Edge Index')}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('landing.edgeIndexDescription', 'Indexed In D1 And Read By Ranged Requests. No Server Holds Your Audio.')}
          </p>
        </Card>
      </div>
    </AppPage>
  );
}
