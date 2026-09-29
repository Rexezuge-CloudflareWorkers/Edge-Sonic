import type { Next } from 'hono';
import type { AdminContext } from '../endpoints/BaseRoute';

type HeaderContext = AdminContext;

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Origin-Agent-Cluster': '?1',
};

// Paths carrying credential secrets or private user data — never cache.
//
// ### The prefix must name a path this router actually serves
//
// This predicate was inherited as `startsWith('/user/')`, which is the *reference
// project's* private surface. This worker has no `/user/` route, so the predicate
// could never return `true` and `Cache-Control: no-store` was never applied to
// anything — `/admin/me` (the operator's own address) and `/admin/users` (every user's
// address) were cacheable. A predicate copied from another router's route table is
// not a conservative default; it is an unconditional no-op.
//
// `/rest/*` is listed for the same reason even though the Subsonic envelope already
// sets `no-store`: a `/rest` response that is not an envelope — a bare `404` from the
// router, a 429 from the limiter — must not be cached either.
function isSensitiveJsonPath(pathname: string): boolean {
  return pathname.startsWith('/admin/') || pathname.startsWith('/rest/');
}

/**
 * Baseline security headers for API JSON responses and the SPA shell.
 * The SPA ships inline scripts/styles from the Vite build, so CSP allows
 * 'unsafe-inline' for scripts + styles (bounded by same-origin + no
 * frame-ancestors). Without it the shell breaks; hashes/nonces are a
 * future tightening once the build emits stable hashes.
 */
function applySecurityHeaders(c: HeaderContext): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(key, value);
  }
  const contentType = c.res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
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
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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

export { securityHeaders, SECURITY_HEADERS, isSensitiveJsonPath, applySecurityHeaders };
