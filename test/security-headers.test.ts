/**
 * The baseline security headers, and the `no-store` predicate.
 *
 * ### The predicate is the thing worth testing
 *
 * `isSensitiveJsonPath` was inherited from the reference project as
 * `startsWith('/user/')` — that project's private surface. This worker registers no
 * `/user/` route, so the predicate could never return `true` and the `Cache-Control:
 * no-store` branch below it was **unreachable**: `/admin/me` and `/admin/users`
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
import { RATE_LIMIT_DEFS, registerRestRateLimits, registerAdminRateLimits } from '../apps/api/src/middleware/rateLimitConfig';

describe('isSensitiveJsonPath', () => {
  it('names a path this router actually serves', () => {
    // Every prefix here is registered in `EdgeSonicWorker`. A prefix with no route is
    // the bug this file exists to prevent.
    expect(isSensitiveJsonPath('/admin/users')).toBe(true);
    expect(isSensitiveJsonPath('/admin/me')).toBe(true);
    expect(isSensitiveJsonPath('/rest/stream.view')).toBe(true);
  });

  it('leaves the public surfaces cacheable', () => {
    // `/health` is probed by a monitor and the SPA shell is a static document; a
    // `no-store` on either would be a cost with no privacy benefit.
    expect(isSensitiveJsonPath('/health')).toBe(false);
    expect(isSensitiveJsonPath('/')).toBe(false);
    expect(isSensitiveJsonPath('/libraries')).toBe(false);
  });

  it('does not match a bare admin path without the separator', () => {
    // A prefix test without the trailing slash would also match `/administrator`.
    expect(isSensitiveJsonPath('/administrator')).toBe(false);
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
  it('carries the baseline and no-store on the admin API', async () => {
    const harness: Harness = await createHarness();
    try {
      const response = await harness.fetch(`${ORIGIN}/admin/users`);
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
      expect(csp).toContain('frame-ancestors \'none\'');
    } finally {
      harness.close();
    }
  });
});

describe('the rate-limit table', () => {
  it('splits by surface as a field, not by array index', async () => {
    // Git slices `RATE_LIMIT_DEFS.slice(0, 3)` / `.slice(3)`, which means inserting a
    // definition at index 3 silently reclassifies it — a new `/rest` limit would become
    // an admin limit and start being keyed on the wrong identity. The `surface` field
    // makes that impossible, and this asserts the split is total and disjoint.
    const rest = RATE_LIMIT_DEFS.filter((def) => def.surface === 'rest');
    const admin = RATE_LIMIT_DEFS.filter((def) => def.surface === 'admin');
    expect(rest.length + admin.length).toBe(RATE_LIMIT_DEFS.length);
    expect(rest.length).toBeGreaterThan(0);
    expect(admin.length).toBeGreaterThan(0);
    for (const def of rest) expect(def.path.startsWith('/rest/'), def.path).toBe(true);
    for (const def of admin) expect(def.path.startsWith('/admin/'), def.path).toBe(true);
  });

  it('gives every definition a reason, so the table can be tuned without archaeology', () => {
    for (const def of RATE_LIMIT_DEFS) {
      expect(def.reason.trim().length, def.keyPrefix).toBeGreaterThan(20);
      expect(def.max, def.keyPrefix).toBeGreaterThan(0);
      expect(def.windowMs, def.keyPrefix).toBeGreaterThan(0);
    }
  });

  it('exports both registrars, and the worker calls one of each', () => {
    // The route order in `EdgeSonicWorker` depends on these being separately callable:
    // `/rest` before its route, `/admin` after the auth middleware. Asserting they are
    // callable is weak, so the ordering itself is asserted in `worker.int.test.ts`.
    expect(typeof registerRestRateLimits).toBe('function');
    expect(typeof registerAdminRateLimits).toBe('function');
  });
});
