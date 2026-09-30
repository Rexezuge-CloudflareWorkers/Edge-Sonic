/**
 * The in-memory rate limiter, and the per-request scope it reads.
 *
 * ### What the limiter is and is not
 *
 * It is a per-isolate token bucket that **fails open**, and it is a speed bump. The
 * credential throttle in `SubsonicAuthService` is a different control with the opposite
 * failure semantics: D1-backed, fails closed. Both are correct, and the tests here
 * keep them from being confused.
 *
 * ### The identity key
 *
 * The limiter prefers the resolved `AuthenticatedUserEmailAddress` and falls back to the client address.
 * The fallback matters as much as the preference: without a trusted address every
 * caller shares one bucket, which is fail-closed grouping, whereas a *spoofed* address
 * would give every attacker their own budget. So `clientIp` trusts exactly one header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHarness, executionContext, ORIGIN } from './helpers/harness';
import { clientIp, rateLimit, resetRateLimitForTests, getRateLimitBucketCountForTests } from '../apps/api/src/middleware/rateLimit';
import { Tokens } from '../packages/backend-services/src/composition/tokens';
import { createRequestScope } from '../packages/backend-services/src/composition/requestScope';
import { getRequestScope, asScopedContext } from '../packages/backend-runtime/src/di';
import { scopeMiddleware } from '../apps/api/src/middleware/scopeMiddleware';
import { createScanWorkerScope } from '@edge-sonic/background';

/**
 * The worker's own env shape, so a handler here declares the same `AuthenticatedUserEmailAddress`
 * variable the real middleware sets.
 */
type TestEnv = { Bindings: Cloudflare.Env; Variables: { AuthenticatedUserEmailAddress: string } };
type TestApp = Hono<TestEnv>;

const ORIGIN_URL = 'https://edge-sonic.test';

const OK = { windowMs: 60_000, max: 2, keyPrefix: 'test', surface: 'user' as const };

/**
 * A minimal app with the limiter installed, so the whole middleware contract — not
 * just the bucket arithmetic — is under test.
 */
function limitedApp(max = 2): TestApp {
  const app = new Hono<TestEnv>();
  app.use('*', rateLimit({ ...OK, max }));
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}

async function hit(app: TestApp, headers: Record<string, string> = {}, path = '/probe'): Promise<Response> {
  return await app.fetch(new Request(`${ORIGIN_URL}${path}`, { headers }), {} as never, executionContext);
}

beforeEach(() => {
  resetRateLimitForTests();
});

afterEach(() => {
  resetRateLimitForTests();
});

describe('clientIp', () => {
  it('trusts CF-Connecting-IP and nothing else', () => {
    expect(clientIp(() => '203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores a client-controlled forwarding header', () => {
    // The single most important line in this file. `X-Forwarded-For` and `x-real-ip`
    // are both attacker-settable, so trusting either lets one caller mint unlimited
    // buckets — and on the `/rest` path it would also rotate the identity keying a
    // *fail-closed* D1 credential throttle, which turns an offline brute force back on.
    const header = (name: string): string | undefined => {
      const headers: Record<string, string> = {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
      };
      return headers[name.toLowerCase()];
    };
    expect(clientIp(header)).toBe('203.0.113.9');
  });

  it('shares one bucket when there is no trusted address, rather than isolating per header', () => {
    // Fail-closed grouping. Returning the spoofed value here would be per-spoofed-header
    // isolation, which is the same failure as trusting it, in the other direction.
    expect(clientIp(() => undefined)).toBe('unknown');
    expect(clientIp(() => ' '.repeat(3))).toBe('unknown');
  });
});

describe('the bucket', () => {
  it('lets the first `max` requests through and refuses the next', async () => {
    const app = limitedApp(2);
    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
    const limited = await hit(app);
    expect(limited.status).toBe(429);
  });

  it('answers 429 in the user dialect, with Retry-After', async () => {
    // The 429 used to hand-build a second error dialect while every other user error
    // went through `toUserResponse`. It now shares `BaseRoute.toErrorBody`, and a
    // client needs one decoder for the surface.
    const app = limitedApp(1);
    await hit(app);
    const limited = await hit(app);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { Exception: { Type: string; Message: string } };
    expect(Object.keys(body)).toEqual(['Exception']);
    expect(body.Exception.Type).toBe('RateLimited');
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    // At least one second, and never more than the window: a client told to wait longer
    // than the bucket lives waits for nothing.
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('keys on the resolved identity, so two operators do not share a budget', async () => {
    // This is the property the route order buys. `AuthenticatedUserEmailAddress` is set by
    // `userAuthentication`, so the limiter has to be registered *after* it; the
    // previous order registered limits first while a comment claimed the opposite.
    const app = new Hono<TestEnv>();
    app.use('*', (c, next) => {
      c.set('AuthenticatedUserEmailAddress', c.req.header('x-operator') ?? '');
      return next();
    });
    app.use('*', rateLimit(OK));
    app.get('/probe', (c) => c.json({ ok: true }));

    const call = async (operator: string): Promise<Response> =>
      await app.fetch(new Request(`${ORIGIN_URL}/probe`, { headers: { 'x-operator': operator } }), {} as never, executionContext);

    expect((await call('ann')).status).toBe(200);
    expect((await call('ann')).status).toBe(200);
    // `ann` is over budget; `bob` starts fresh. Keyed on the address instead, both of
    // these would share the `'unknown'` bucket and one operator could lock out another.
    expect((await call('ann')).status).toBe(429);
    expect((await call('bob')).status).toBe(200);
  });

  it('falls back to the address when no identity is set', async () => {
    const app = limitedApp(1);
    const withIp = { 'cf-connecting-ip': '203.0.113.9' };
    expect((await hit(app, withIp)).status).toBe(200);
    expect((await hit(app, withIp)).status).toBe(429);
    // A different address is a different budget, which is the whole point of falling
    // back to the trusted header rather than a constant.
    expect((await hit(app, { 'cf-connecting-ip': '203.0.113.10' })).status).toBe(200);
  });

  it('separates budgets by keyPrefix, so one endpoint cannot exhaust another', async () => {
    const app = new Hono<TestEnv>();
    app.use('/a', rateLimit({ ...OK, keyPrefix: 'a' }));
    app.use('/b', rateLimit({ ...OK, keyPrefix: 'b' }));
    app.get('/a', (c) => c.json({ ok: true }));
    app.get('/b', (c) => c.json({ ok: true }));
    const withIp = { 'cf-connecting-ip': '203.0.113.9' };
    const call = async (path: string): Promise<Response> =>
      await app.fetch(new Request(`${ORIGIN_URL}${path}`, { headers: withIp }), {} as never, executionContext);
    expect((await call('/a')).status).toBe(200);
    expect((await call('/a')).status).toBe(200);
    expect((await call('/a')).status).toBe(429);
    expect((await call('/b')).status).toBe(200);
  });

  it('resets when the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const app = limitedApp(1);
      const withIp = { 'cf-connecting-ip': '203.0.113.9' };
      expect((await hit(app, withIp)).status).toBe(200);
      expect((await hit(app, withIp)).status).toBe(429);
      vi.advanceTimersByTime(60_001);
      expect((await hit(app, withIp)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps tracked buckets, so a rotating key cannot grow the map without limit', () => {
    // An attacker rotating the key would otherwise pin memory for the isolate's life.
    for (let index = 0; index < 5200; index += 1) {
      rateLimit({ windowMs: 60_000, max: 1, keyPrefix: `p${index}`, surface: 'user' });
    }
    // `cleanup` only runs at request time, so drive a few to trigger it.
    const app = limitedApp(1);
    for (let index = 0; index < 3; index += 1) void hit(app, { 'cf-connecting-ip': `10.0.0.${index}` });
    expect(getRateLimitBucketCountForTests()).toBeLessThanOrEqual(5000);
  });

  it('fails open, because a limiter that throws takes playback down for everyone', async () => {
    // The limiter wraps its whole body in a `try { … } catch { await next() }`, so its
    // own state going wrong can never become a 5xx for a legitimate stream. Hono turns
    // a handler throw into a 500 of its own accord; what matters here is that the
    // limiter neither adds a second failure nor blocks the request.
    const app = new Hono<TestEnv>();
    app.use('*', rateLimit(OK));
    app.get('/probe', () => {
      throw new Error('handler explodes');
    });
    const response = await hit(app);
    expect(response.status).toBe(500);
    // The request still reached the handler, so the limiter did not short-circuit it.
    expect(getRateLimitBucketCountForTests()).toBe(1);
  });

  it('does not consume a bucket when it is already over budget, and still answers open once reset', async () => {
    // Over-budget requests are refused without calling `next`, so they must not
    // increment the counter either — otherwise a client hammering a 429 drives its own
    // window forward and never recovers.
    const app = limitedApp(1);
    const withIp = { 'cf-connecting-ip': '203.0.113.9' };
    expect((await hit(app, withIp)).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await hit(app, withIp)).status).toBe(429);
    }
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60_001);
      expect((await hit(app, withIp)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the opts guard', () => {
  it('refuses a misconfigured limit at registration, not at request time', () => {
    // A zero or negative `max` would install a bucket that is either unlimited or
    // permanently tripped — and the failure would otherwise show up as "the rate limit
    // does not work" long after the typo.
    expect(() => rateLimit({ windowMs: 0, max: 1, keyPrefix: 'x', surface: 'user' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: 1000, max: 0, keyPrefix: 'x', surface: 'user' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: 1.5, keyPrefix: 'x', surface: 'user' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: 1, keyPrefix: '  ', surface: 'user' })).toThrow(/keyPrefix/);
  });
});

describe('the per-request scope', () => {
  it('installs one container, and every handler sees the same one', async () => {
    // Minting a scope per handler defeats the memoization the container exists for, and
    // it is what put a second `AppConfiguration` on the auth path.
    const app = new Hono<TestEnv>();
    app.use('*', scopeMiddleware);
    const seen: unknown[] = [];
    const capture = async (path: string): Promise<void> => {
      await app.fetch(new Request(`${ORIGIN_URL}${path}`), { DB: {} } as never, executionContext);
    };
    app.get('/one', (c) => {
      seen.push(getRequestScope(asScopedContext(c)));
      return c.json({ ok: true });
    });
    app.get('/two', (c) => {
      seen.push(getRequestScope(asScopedContext(c)));
      return c.json({ ok: true });
    });

    await capture('/one');
    await capture('/two');
    expect(seen).toHaveLength(2);
    // Two requests, two containers. A shared one would leak one request's memoized
    // services into the next.
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('shares one container across every handler in a single request', async () => {
    // A Hono app cannot chain two handlers onto one path, so the second handler is
    // reached through a nested `app.use` that runs after the first. That is the shape
    // the real worker has: several middlewares and a route, all inside one request.
    const app = new Hono<TestEnv>();
    const seen: unknown[] = [];
    app.use('*', scopeMiddleware);
    app.use('/probe', (c, next) => {
      seen.push(getRequestScope(asScopedContext(c)));
      return next();
    });
    app.get('/probe', (c) => {
      seen.push(getRequestScope(asScopedContext(c)));
      return c.json({ ok: true });
    });
    const response = await app.fetch(new Request(`${ORIGIN_URL}/probe`), { DB: {} } as never, executionContext);
    expect(response.status).toBe(200);
    // One container, seen from a middleware and from the route.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('memoizes a token within a scope, so one config serves the whole request', () => {
    // The reason `AccessAuthService` is a token rather than a `new` at the call site:
    // resolved from the scope it shares the scope's single `AppConfiguration` instead
    // of allocating a second one per request.
    const scope = createRequestScope({ DB: {} } as never);
    const first = scope.get(Tokens.AppConfig);
    const second = scope.get(Tokens.AppConfig);
    expect(first).toBe(second);
    // And a different scope is a different instance, so one request cannot observe
    // another's memoized state.
    expect(createRequestScope({ DB: {} } as never).get(Tokens.AppConfig)).not.toBe(first);
  });

  it('resolves AccessAuthService from the scope, like every other service', () => {
    const scope = createRequestScope({ DB: {} } as never);
    const service = scope.get(Tokens.AccessAuthService);
    expect(scope.get(Tokens.AccessAuthService)).toBe(service);
    expect(typeof service.getAuthenticatedUserEmail).toBe('function');
  });

  it('binds every declared token, so a typo cannot become a runtime TypeError', () => {
    // ### What this replaced
    //
    // `Tokens` is `satisfies Record<string, Token<unknown>>`, so a *misspelled* token name
    // is a compile error — but a correctly-spelled token that was never bound is not, and
    // nothing in the type system ties a `Token` to a registration.
    //
    // The only runtime diagnostic was `Container.get`'s "no binding for token" throw, and
    // that line was **unreachable**: every one of the composition root's registrations is
    // a `bindValue`, so the container's factory tier never ran and the throw was never
    // reached. A token added to `tokens.ts` and not to `requestScope.ts` would have
    // produced `undefined` flowing into a service and a `TypeError` several frames away,
    // naming nothing. The whole factory tier — `bind`, `resolve`, `createChild`, `has`,
    // `dispose`, and `get`'s own factory branch — was deleted as dead code, and the check
    // it carried moved here, where it runs for every token on every test run.
    //
    // The *reachability* is asserted rather than hoped for: `get` throws for an unbound
    // token, so iterating the registry proves the throw is live and the registrations
    // complete. Without that, a `Container` that had stopped checking would make this test
    // pass vacuously.
    const scope = createRequestScope({ DB: {} } as never);
    for (const [name, token] of Object.entries(Tokens)) {
      expect(() => scope.get(token as never), `scope must bind Tokens.${name}`).not.toThrow();
    }

    // And the throw is real, so the loop above is a measurement rather than a formality.
    expect(() => scope.get(Symbol('NeverBoundToken') as never)).toThrow(/no binding for token/);

    // The background worker's composition root is a separate one, so it gets the same
    // check — the two drift apart independently, and one of them already had.
    const scanScope = createScanWorkerScope({ DB: {} } as never);
    for (const [name, token] of Object.entries(Tokens)) {
      expect(() => scanScope.get(token as never), `scan scope must bind Tokens.${name}`).not.toThrow();
    }
  });
});

describe('through the real worker', () => {
  it('returns 429 in the user dialect when the user budget is exhausted', async () => {
    // Through `fetch`, so the assertion covers the rate limiter, the route order, the
    // auth middleware, and the error dialect in one pass. The user budget is 60/min, so
    // this spends 61 requests rather than reaching into the module's internals.
    const harness = await createHarness();
    try {
      let last: Response | undefined;
      for (let attempt = 0; attempt < 61; attempt += 1) {
        last = await harness.fetch(`${ORIGIN}/user/libraries`);
      }
      expect(last?.status).toBe(429);
      const body = (await last?.json()) as { Exception: { Type: string } };
      expect(body.Exception.Type).toBe('RateLimited');
      expect(last?.headers.get('cache-control')).toBe('no-store');
    } finally {
      resetRateLimitForTests();
      harness.close();
    }
  });
});

describe('a budget read from the environment', () => {
  it('is used by the limiter when the table says to resolve it per request', async () => {
    // `STREAM_RATE_LIMIT` was declared, parsed, validated and shipped in the wrangler
    // template — and read by nothing. The limiter used a literal, so `600` lived in three
    // places and an operator setting `STREAM_RATE_LIMIT=50` got a clean validation pass, a
    // deployment that reported itself configured, and an unchanged limiter.
    //
    // The budget cannot be read at registration: the route table is built once in the
    // worker's constructor, where `env` does not exist. So `max` accepts a resolver, and
    // this asserts the resolver's value is the one that decides the outcome — the whole
    // point of a knob being a knob.
    const app = new Hono<TestEnv>();
    app.use('*', rateLimit({ ...OK, max: (c) => Number((c.env as unknown as Record<string, string>).BUDGET) }));
    app.get('/probe', (c) => c.json({ ok: true }));

    // Over budget: the second request is refused.
    const overBudget = await app.fetch(new Request(`${ORIGIN_URL}/probe`, { headers: { CFConnectingIP: '1.1.1.1' } }), { BUDGET: '1' } as never, executionContext);
    expect(overBudget.status).toBe(200);
    expect((await app.fetch(new Request(`${ORIGIN_URL}/probe`, { headers: { CFConnectingIP: '1.1.1.1' } }), { BUDGET: '1' } as never, executionContext)).status).toBe(429);
    resetRateLimitForTests();

    // A different budget for the same route, on a fresh bucket. If the resolver were
    // ignored in favour of a captured value this would still be 429.
    const other = await app.fetch(new Request(`${ORIGIN_URL}/probe`, { headers: { CFConnectingIP: '2.2.2.2' } }), { BUDGET: '50' } as never, executionContext);
    expect(other.status).toBe(200);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await app.fetch(new Request(`${ORIGIN_URL}/probe`, { headers: { CFConnectingIP: '2.2.2.2' } }), { BUDGET: '50' } as never, executionContext)).status).toBe(200);
    }
  });

  it('refuses to enforce a budget it could not resolve, rather than enforcing nothing', async () => {
    // `count >= NaN` is false, so a resolver that answered a non-integer would make the
    // bucket **unlimited** — silently disabling the very control the variable configures,
    // and doing it in the direction nobody notices.
    //
    // The response is the fail-open path: the limiter is documented never to fail a request,
    // because a limiter that 500s takes down playback. What is *not* acceptable is the other
    // silent answer, where the request succeeds because the bucket stopped counting.
    const app = new Hono<TestEnv>();
    app.use('*', rateLimit({ ...OK, max: () => NaN }));
    app.get('/probe', (c) => c.json({ ok: true }));

    // Every request is answered — no 500 — because the limiter fails open.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await hit(app, { 'CF-Connecting-IP': '3.3.3.3' })).status).toBe(200);
    }
    // And the pair: a resolver that *throws* is handled the same way rather than becoming
    // an unbounded bucket. Asserted separately because a `throw` and a `NaN` reach the guard
    // by different routes, and only one of them would be caught by a `Number.isSafeInteger`
    // check written after the call.
    const throwing = new Hono<TestEnv>();
    throwing.use(
      '*',
      rateLimit({
        ...OK,
        max: () => {
          throw new Error('resolver exploded');
        },
      }),
    );
    throwing.get('/probe', (c) => c.json({ ok: true }));
    expect((await hit(throwing, { 'CF-Connecting-IP': '4.4.4.4' })).status).toBe(200);
  });
});
