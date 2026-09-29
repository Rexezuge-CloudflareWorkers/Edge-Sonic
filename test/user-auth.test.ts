/**
 * The user authentication boundary.
 *
 * `/user/*` is guarded by Cloudflare Access and `/rest/*` by a Subsonic token. Keeping
 * them apart is a security property, so these tests are about which credential is
 * accepted where, and — more importantly — which ones are refused.
 *
 * The three rules under test:
 *
 * 1. **`Cf-Access-Authenticated-User-Email` is never trusted.** Cloudflare documents
 *    it as a *response* header it sets; if it is read back as a *request* header, any
 *    caller can name themselves. The reference project this was scaffolded from had
 *    exactly that bug.
 * 2. **A bypass is gated on an allow-list of environments, not a deny-list.** The
 *    dangerous direction is an unknown `ENVIRONMENT` silently enabling the bypass,
 *    because a deny-list authenticates every unauthenticated request as a fixed user.
 * 3. **An unverified identity inside the trusted binding still does not
 *    authenticate.** The binding is trusted; what it contains is not, until it says so.
 */
import { describe, expect, it } from 'vitest';
import { AccessAuthService, DEMO_USER_EMAIL } from '@edge-sonic/backend-services/auth';
import type { AccessBinding, AccessIdentity } from '@edge-sonic/backend-services/auth';
import { UnauthorizedError } from '@edge-sonic/backend-errors';

const ORIGIN = 'https://edge-sonic.test';

function userRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/user/libraries`, { headers });
}

/**
The `ACCESS` binding, as the platform provides it.

`getIdentity` resolves **`undefined`** — not `null` — when no Access application is in
front of the request, and that is the value the tests below lean on. The previous
version of this helper hung the identity off an `access` property of a cast
`ExecutionContext`, which no real Hono context has: the branch could never execute, so
these tests asserted a path the deployed worker never took.
*/
function accessBinding(identity: AccessIdentity | undefined, throws = false): AccessBinding {
  return {
    getIdentity: async () => {
      if (throws) throw new Error('binding unavailable');
      return identity;
    },
  };
}

const PRODUCTION = { ENVIRONMENT: 'production', TEAM_DOMAIN: 'example.cloudflareaccess.com', POLICY_AUD: 'aud' };

describe('the dev bypass', () => {
  it('returns the fixed address in demo mode, without any credential', async () => {
    // Demo mode is a deliberate, environment-gated "no login at all" switch. It exists
    // so a public demo can be tried without provisioning, which is exactly why it must
    // be impossible to turn on in production.
    const service = new AccessAuthService({ ENVIRONMENT: 'development', DEMO_MODE: 'true' });
    expect(await service.getAuthenticatedUserEmail(userRequest())).toBe(DEMO_USER_EMAIL);
  });

  it('lowercases the configured address, because the user API keys on it', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: '  Operator@Example.COM  ' });
    expect(await service.getAuthenticatedUserEmail(userRequest())).toBe('operator@example.com');
  });

  it('refuses a configured value that is not an address, rather than trusting it', async () => {
    // A typo in the variable must not become an identity that matches nothing — or,
    // worse, one that matches a header the caller controls.
    for (const value of ['not-an-email', 'has space@example.com', '@example.com', 'a@b', '']) {
      const service = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: value });
      await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
    }
  });

  it('is inert in production, and in an environment it does not recognize', async () => {
    // The allow-list, not a deny-list: `staging`, `Preview`, and a misspelled
    // `prodcution` all fall on the safe side.
    for (const environment of ['production', 'Preview', 'staging', 'prodcution', '', undefined]) {
      const service = new AccessAuthService({ ...PRODUCTION, ENVIRONMENT: environment, DEV_AUTH_EMAIL: 'operator@example.com' });
      await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
    }
  });
});

describe('the header Access sets is not a credential', () => {
  it('rejects a request carrying only Cf-Access-Authenticated-User-Email', async () => {
    // This is the invariant. Cloudflare sets that header on the *response* to the
    // browser; reading it back from the request means any caller can send it and name
    // themselves, and an operator's user session becomes a single forged header.
    const service = new AccessAuthService(PRODUCTION);
    const request = userRequest({ 'cf-access-authenticated-user-email': 'attacker@example.com' });
    await expect(service.getAuthenticatedUserEmail(request)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects it even alongside a forged Cookie', async () => {
    // A cookie is not consulted either. Only a signed assertion or the binding counts,
    // and neither of these is one.
    const service = new AccessAuthService(PRODUCTION);
    const request = userRequest({
      'cf-access-authenticated-user-email': 'attacker@example.com',
      cookie: 'CF_Authorization=anything',
    });
    await expect(service.getAuthenticatedUserEmail(request)).rejects.toThrow(UnauthorizedError);
  });
});

describe('the Access binding', () => {
  it('accepts a verified identity, lowercased and trimmed', async () => {
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding({ email: '  Ann@Example.com ', emailVerified: true }) });
    const email = await service.getAuthenticatedUserEmail(userRequest());
    expect(email).toBe('ann@example.com');
  });

  it('refuses an identity that is explicitly unverified', async () => {
    // The binding is trusted; what it contains is not, until it says so. A
    // false-negative here is an unauthenticated user API.
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding({ email: 'ann@example.com', emailVerified: false }) });
    await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
  });

  it('refuses the snake_case spelling of unverified too', async () => {
    // Cloudflare has used both spellings. Accepting one and not the other is a
    // fail-open that only shows up in production.
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding({ email: 'ann@example.com', email_verified: false }) });
    await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
  });

  it('refuses when the binding itself throws, rather than falling through to nobody', async () => {
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding(undefined, true) });
    await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
  });

  it('refuses an undefined identity and an identity with no address', async () => {
    // `undefined` is what the platform resolves when no Access application is in front
    // of the request. It is the value a real deployment returns most often, so it must
    // be the value under test rather than a `null` nothing produces.
    const empty = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding(undefined) });
    await expect(empty.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
    const blank = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding({ email: ' '.repeat(3) }) });
    await expect(blank.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(UnauthorizedError);
  });

  it('refuses when there is no binding at all', async () => {
    // The common case: a deployment without Access in front of it. The answer is 401,
    // not an open door, and not an error about configuration — the caller learns only
    // that they are not authenticated.
    const service = new AccessAuthService(PRODUCTION);
    await expect(service.getAuthenticatedUserEmail(userRequest())).rejects.toThrow(/authentication failed/i);
  });

  it('stays reachable after the JWT path fails soft', async () => {
    // The chain order is invisible until it is wrong. The JWT path must fail *soft* so
    // this fallback remains reachable: if it threw, an unconfigured audience or a
    // signature failure would lock out every deployment that relies on the binding, and
    // the `describe` block above would be testing a branch nothing can enter.
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding({ email: 'ann@example.com' }) });
    const request = userRequest({
      // eslint-disable-next-line sonarjs/no-hardcoded-secrets -- a deliberately invalid assertion.
      'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFubkBleGFtcGxlLmNvbSJ9.not-a-signature',
    });
    expect(await service.getAuthenticatedUserEmail(request)).toBe('ann@example.com');
  });

  it('refuses a bad assertion when the binding reports no identity either', async () => {
    // The two paths are tried in order, not or-ed. A request that presents an assertion
    // this server cannot verify, on a deployment whose binding has no identity, is
    // unauthenticated — the failed assertion must not be treated as a reason to stop
    // looking, and its absence must not be treated as a reason to answer.
    const service = new AccessAuthService({ ...PRODUCTION, ACCESS: accessBinding(undefined) });
    const request = userRequest({
      // eslint-disable-next-line sonarjs/no-hardcoded-secrets -- a deliberately invalid assertion.
      'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFubkBleGFtcGxlLmNvbSJ9.not-a-signature',
    });
    await expect(service.getAuthenticatedUserEmail(request)).rejects.toThrow(UnauthorizedError);
  });
});

describe('verifyAccessJwt', () => {
  it('names a missing token, because that is a configuration problem, not a forgery', async () => {
    await expect(AccessAuthService.verifyAccessJwt(userRequest(), 'example.cloudflareaccess.com', 'aud')).rejects.toThrow(/No Cloudflare Access JWT/);
  });

  it('refuses to verify without a team domain or an audience', async () => {
    // A structurally valid but unsigned JWT. Not a credential: it is a literal from the
    // RFC 7519 appendix, and it is here to be *rejected*, which is the whole test.
    // eslint-disable-next-line sonarjs/no-hardcoded-secrets
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFubkBleGFtcGxlLmNvbSJ9.sig';
    await expect(AccessAuthService.verifyAccessJwt(userRequest({ 'cf-access-jwt-assertion': token }), '', 'aud')).rejects.toThrow(/configuration/i);
    await expect(AccessAuthService.verifyAccessJwt(userRequest({ 'cf-access-jwt-assertion': token }), 'example.com', '  ')).rejects.toThrow(/configuration/i);
  });

  it('rejects a multi-valued audience instead of failing inside the verifier', async () => {
    // A comma-joined `POLICY_AUD` otherwise produces "signature verification failed",
    // which sends an operator hunting for a key problem that does not exist.
    // A structurally valid but unsigned JWT. Not a credential: it is a literal from the
    // RFC 7519 appendix, and it is here to be *rejected*, which is the whole test.
    // eslint-disable-next-line sonarjs/no-hardcoded-secrets
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFubkBleGFtcGxlLmNvbSJ9.sig';
    await expect(AccessAuthService.verifyAccessJwt(userRequest({ 'cf-access-jwt-assertion': token }), 'example.com', 'a,b')).rejects.toThrow(
      /Multiple JWT audiences/,
    );
  });

  it('collapses every signature failure into one message', async () => {
    // Telling an unauthenticated caller *which* part of the token they got right — the
    // issuer, the audience, the expiry — is a free oracle for building a valid one.
    // eslint-disable-next-line sonarjs/no-hardcoded-secrets -- a deliberately invalid token.
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFubkBleGFtcGxlLmNvbSJ9.not-a-signature';
    await expect(AccessAuthService.verifyAccessJwt(userRequest({ 'cf-access-jwt-assertion': token }), 'example.com', 'aud')).rejects.toThrow(
      'Cloudflare Access authentication failed.',
    );
  });

  it('does not attempt a network fetch when the request has no token', async () => {
    // The throw happens before `jwksFor`, so a request with no credential costs no
    // subrequest to the Access CDN — which matters under a request flood.
    let constructed = 0;
    const originalFetch = fetch;
    globalThis.fetch = (async () => {
      constructed += 1;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(AccessAuthService.verifyAccessJwt(userRequest(), 'example.cloudflareaccess.com', 'aud')).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(constructed).toBe(0);
  });
});
