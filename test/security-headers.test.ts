/**
 * The baseline security headers, and the `no-store` predicate.
 *
 * ### The predicate is the thing worth testing
 *
 * `isSensitiveJsonPath` was inherited from the reference project as
 * `startsWith('/user/')` — that project's private surface. This worker registers no
 * `/user/` route, so the predicate could never return `true` and the `Cache-Control:
 * no-store` branch below it was **unreachable**: `/user/me` and `/user/users`
 * shipped with no `Cache-Control` at all, and the code read as though they did.
 *
 * A predicate copied from another router's route table is not a conservative default.
 * It is an unconditional no-op, and nothing else in the app would have said so — the
 * `/rest` envelope sets its own `no-store`, so the tests that existed all passed.
 */
import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { ORIGIN } from './helpers/harness';
import { SECURITY_HEADERS, isSensitiveJsonPath } from '../apps/api/src/middleware/securityHeaders';
import {
  RATE_LIMIT_DEFS,
  registerRestRateLimits,
  registerShareRateLimits,
  registerUserRateLimits,
} from '../apps/api/src/middleware/rateLimitConfig';

describe('isSensitiveJsonPath', () => {
  it('names a path this router actually serves', () => {
    // Every prefix here is registered in `EdgeSonicWorker`. A prefix with no route is
    // the bug this file exists to prevent.
    expect(isSensitiveJsonPath('/user/users')).toBe(true);
    expect(isSensitiveJsonPath('/user/me')).toBe(true);
    expect(isSensitiveJsonPath('/rest/stream.view')).toBe(true);
    // A share id `is` the credential, so a cached page hands the capability to whoever shares
    // the cache. This is the prefix the predicate gained with the feature, and the assertion
    // that would notice it being dropped.
    expect(isSensitiveJsonPath('/share/3f2a7c1e-0000-4000-8000-000000000000')).toBe(true);
  });

  it('leaves the public surfaces cacheable', () => {
    // `/health` is probed by a monitor and the SPA shell is a static document; a
    // `no-store` on either would be a cost with no privacy benefit.
    expect(isSensitiveJsonPath('/health')).toBe(false);
    expect(isSensitiveJsonPath('/')).toBe(false);
    expect(isSensitiveJsonPath('/libraries')).toBe(false);
  });

  it('does not match a bare user path without the separator', () => {
    // A prefix test without the trailing slash would also match `/useradmin`.
    expect(isSensitiveJsonPath('/useradmin')).toBe(false);
    expect(isSensitiveJsonPath('/restful')).toBe(false);
  });
});

describe('SECURITY_HEADERS', () => {
  it('is the agreed baseline, with nothing missing', () => {
    // The set is duplicated from Git's on purpose, so a change here is a change to the
    // security posture and shows up as a diff rather than as a silent omission.
    expect(SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Origin-Agent-Cluster': '?1',
    });
  });
});

describe('the headers on a real response', () => {
  it('carries the baseline and no-store on the user API', async () => {
    const harness: Harness = await createHarness();
    try {
      const response = await harness.fetch(`${ORIGIN}/user/users`);
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name), name).toBe(value);
      }
      // The assertion that would have caught the inherited predicate.
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = (await response.json()) as { users: unknown[] };
      expect(body.users.length).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  });

  it('sends HSTS over https, and the SPA shell gets the CSP', async () => {
    // The harness origin is https, which is the only scheme a Workers deployment is
    // reached on. HSTS over plain http would be a pinning risk locally and is ignored
    // by browsers, which is why `applySecurityHeaders` gates it on the protocol.
    const harness = await createHarness();
    try {
      const response = await harness.fetch(`${ORIGIN}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      // JSON, not HTML: the CSP belongs to the shell only, and sending it here would be
      // a header nobody asked for on a surface that is never rendered.
      expect(response.headers.get('content-security-policy')).toBeNull();

      const shell = await harness.fetch(`${ORIGIN}/`);
      expect(shell.headers.get('content-type')).toContain('text/html');
      const csp = shell.headers.get('content-security-policy') ?? '';
      // The SPA ships inline scripts and styles from the Vite build, so 'unsafe-inline'
      // is load-bearing until the build emits stable hashes.
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-ancestors 'none'");
    } finally {
      harness.close();
    }
  });
});

describe('the rate-limit table', () => {
  it('splits by surface as a field, not by array index', async () => {
    // Git slices `RATE_LIMIT_DEFS.slice(0, 3)` / `.slice(3)`, which means inserting a
    // definition at index 3 silently reclassifies it — a new `/rest` limit would become
    // a user limit and start being keyed on the wrong identity. The `surface` field
    // makes that impossible, and this asserts the split is total and disjoint across the
    // three surfaces the worker now serves.
    const rest = RATE_LIMIT_DEFS.filter((def) => def.surface === 'rest');
    const user = RATE_LIMIT_DEFS.filter((def) => def.surface === 'user');
    const share = RATE_LIMIT_DEFS.filter((def) => def.surface === 'share');
    expect(rest.length + user.length + share.length).toBe(RATE_LIMIT_DEFS.length);
    expect(rest.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
    expect(share.length).toBeGreaterThan(0);
    for (const def of rest) expect(def.path.startsWith('/rest/'), def.path).toBe(true);
    for (const def of user) expect(def.path.startsWith('/user/'), def.path).toBe(true);
    for (const def of share) expect(def.path.startsWith('/share/'), def.path).toBe(true);
  });

  it('gives every definition a reason, so the table can be tuned without archaeology', () => {
    for (const def of RATE_LIMIT_DEFS) {
      expect(def.reason.trim().length, def.keyPrefix).toBeGreaterThan(20);
      expect(def.max, def.keyPrefix).toBeGreaterThan(0);
      expect(def.windowMs, def.keyPrefix).toBeGreaterThan(0);
    }
  });

  it('exports all three registrars, and the worker calls one of each', () => {
    // The route order in `EdgeSonicWorker` depends on these being separately callable:
    // `/rest` and `/share` before their routes, `/user` after the auth middleware.
    // Asserting they are callable is weak, so the ordering itself is asserted in
    // `worker.int.test.ts`.
    expect(typeof registerRestRateLimits).toBe('function');
    expect(typeof registerUserRateLimits).toBe('function');
    expect(typeof registerShareRateLimits).toBe('function');
  });
});

describe('the headers on a share page', () => {
  it('never caches the capability id, and sends the tight CSP', async () => {
    // A share id is the whole credential: a cached page hands it to whoever shares the cache,
    // and a `Referer` leaks it to the next site the visitor follows. The page also renders
    // attacker-controlled filenames, so it gets `default-src 'none'` rather than the SPA's
    // policy, which allows inline script.
    const harness: Harness = await createHarness();
    try {
      const response = await harness.fetch(`${ORIGIN}/share/does-not-exist`);
      // The 404 is the answer, and the headers must still be there — a miss is exactly the
      // response a cache would otherwise keep and replay to a later, valid visitor.
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('unsafe-inline');
    } finally {
      harness.close();
    }
  });
});
