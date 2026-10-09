/**
 * Warnings about the two settings that decide who is allowed in, and where the worker may
 * connect.
 *
 * Split out of [`validate.ts`](./validate.ts) because these are the only checks in that module
 * whose subject is a **combination** of two settings — `ALLOW_PRIVATE_WEBDAV_HOSTS` with
 * `ENVIRONMENT`, the bypass with `ENVIRONMENT` — and a combination is not visible in a list of
 * single-variable checks. Read in one place, they also say plainly that only the dangerous
 * direction is reported: an inert setting gets a `Note`, a re-opened SSRF surface gets
 * `Security:`, and an active bypass in development gets nothing, because warning about the
 * intended local setup is how a report stops being read.
 */
import type { AuthConfig } from './sections/AuthConfig';
import type { LibraryLimits } from './sections/LibraryLimits';

/**
 * `TEAM_DOMAIN` feeds the JWKS URL, so a scheme-less value throws inside `jose`.
 */
function isParsableTeamDomain(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Warnings about the local-development auth bypass.
 *
 * The bypass present but **inert** is the dangerous direction — one edit to `ENVIRONMENT` away
 * from authenticating everyone as a fixed identity — so that is what is reported. An *active*
 * bypass is the intended local setup and is deliberately not reported: warning about it would
 * train an operator to ignore every line this method emits.
 *
 * Its own function because the rule is about the *pair* of variables and `ENVIRONMENT`, and
 * inlining it put three conditions and their reasoning in the middle of a list of unrelated
 * checks where it read as one more key-value test.
 */
function authBypassWarnings(auth: AuthConfig): string[] {
  if (auth.isBypassAllowed()) return [];
  if (auth.getDevAuthEmail() === null && !auth.isDemoMode()) return [];

  return [
    `Security: DEV_AUTH_EMAIL/DEMO_MODE is set while ENVIRONMENT=${auth.getEnvironment()}. ` +
      `The bypass is ignored in this environment; remove the variable so it cannot become live if ENVIRONMENT changes.`,
  ];
}

/**
 * Warnings about `ALLOW_PRIVATE_WEBDAV_HOSTS`, which is three states rather than two.
 *
 * Set outside a bypass re-opens the SSRF surface the default exists to close, and the
 * credential angle is what makes it worse than usual: the worker attaches the stored WebDAV
 * password to every request to that origin. Set *inside* one it is inert in both directions, and
 * an inert setting is reported because an operator who set it has been told it did something.
 *
 * All three branches are the same predicate over `{true, false} × {bypass, no bypass}`, so they
 * are one table rather than three `if`s — which is also what makes the pair comparable: the
 * warning is *about* the combination, and a combination is not visible in three separate tests.
 */
function privateHostWarnings(library: LibraryLimits, auth: AuthConfig): string[] {
  // **Unset is not `false`.** `getAllowPrivateWebdavHosts` is a tri-state — `true`, `false`, and
  // `null` for "the variable is absent" — and `null` inherits the bypass's own answer rather than
  // asserting anything. Comparing it against the bypass with `!==` reported the absent variable
  // as `ALLOW_PRIVATE_WEBDAV_HOSTS=null has no effect`, on every deployment that never set it: a
  // warning attached to the default configuration, which is how a report stops being read.
  const configured = library.getAllowPrivateWebdavHosts();
  if (configured === null) return [];
  const bypass = auth.isBypassAllowed();
  const environment = auth.getEnvironment();

  // The environment decides: inside a bypass private hosts are allowed, outside they are denied.
  // So a setting that **agrees** with that is inert, and an operator who set it has been told it
  // did something — hence the Note.
  if (configured === bypass) {
    return [
      `Note: ALLOW_PRIVATE_WEBDAV_HOSTS=${String(configured)} has no effect while ENVIRONMENT=${environment} (private hosts are already ${bypass ? 'allowed' : 'denied'}).`,
    ];
  }
  // Disagreeing means either widening the SSRF surface, which is the Security warning, or
  // narrowing it inside a bypass, which is safe and so silent.
  if (configured) {
    return [
      `Security: ALLOW_PRIVATE_WEBDAV_HOSTS=true while ENVIRONMENT=${environment}. ` +
        `Libraries may target loopback and private-network origins, and the worker sends the stored WebDAV credential to them.`,
    ];
  }
  return [];
}

export { authBypassWarnings, isParsableTeamDomain, privateHostWarnings };
