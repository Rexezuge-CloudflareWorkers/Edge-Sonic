import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, sensitivePaths, STRICT_TRANSPORT_SECURITY } from '@rexezuge/http';
import type { Next } from 'hono';
import type { UserContext } from '../endpoints/BaseRoute';

type HeaderContext = UserContext;

/**
 * Paths carrying credential secrets or private user data — never cache.
 *
 * ### The prefix must name a path this router actually serves
 *
 * This predicate was inherited as `startsWith('/user/')`, which is the *reference
 * project's* private surface. This worker has no `/user/` route, so the predicate
 * could never return `true` and `Cache-Control: no-store` was never applied to
 * anything — `/user/me` (the operator's own address) and `/user/users` (every user's
 * address) were cacheable. A predicate copied from another router's route table is
 * not a conservative default; it is an unconditional no-op.
 *
 * `/rest` is listed for the same reason even though the Subsonic envelope already
 * sets `no-store`: a `/rest` response that is not an envelope — a bare `404` from the
 * router, a 429 from the limiter — must not be cached either.
 *
 * The kit's `sensitivePaths` builds exactly this predicate from prefixes given as
 * **arguments**, which is the fix: the shape that lets a route table forget to name
 * its own sensitive paths is a required argument, not a default. A named export is
 * kept here because `test/security-headers.test.ts` asserts this predicate's answer
 * directly, and that assertion is the only thing that would have noticed the
 * inherited one was a no-op.
 */
const isSensitiveJsonPath = sensitivePaths('/user', '/rest');

/**
 * Baseline security headers for API JSON responses and the SPA shell.
 *
 * Every constant and every decision is the kit's: the header table, the CSP, the
 * HSTS value, and the parse-inside-a-`try` shape that guarantees a malformed URL
 * cannot fail the request. The CSP allows `'unsafe-inline'` for scripts and styles
 * because the SPA ships inline from the Vite build; it is bounded by same-origin
 * and `frame-ancestors 'none'`, and hashes or nonces are the tightening once the
 * build emits stable ones.
 */
function applySecurityHeaders(c: HeaderContext): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(key, value);
  }
  const contentType = c.res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  }
  // Bucket-credential JSON must never be cached by browsers or CDNs.
  try {
    const pathname = new URL(c.req.url).pathname;
    if (isSensitiveJsonPath(pathname)) {
      c.header('Cache-Control', 'no-store');
    }
  } catch {
    // URL parsing must never fail the request.
  }
  // HSTS only over HTTPS — sending it over plain HTTP risks local pinning
  // and is ignored by browsers anyway.
  try {
    if (new URL(c.req.url).protocol === 'https:') {
      c.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    }
  } catch {
    // URL parsing must never fail the request.
  }
}

function securityHeaders(): (c: HeaderContext, next: Next) => Promise<Response | void> {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  return async (c: HeaderContext, next: Next): Promise<Response | void> => {
    await next();
    try {
      applySecurityHeaders(c);
    } catch {
      // Headers must never fail the request.
    }
  };
}

export { securityHeaders, isSensitiveJsonPath, applySecurityHeaders };
export { SECURITY_HEADERS, CONTENT_SECURITY_POLICY, STRICT_TRANSPORT_SECURITY } from '@rexezuge/http';
