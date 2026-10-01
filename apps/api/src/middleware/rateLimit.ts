import type { Next } from 'hono';
import { RateLimitedError } from '@edge-sonic/backend-errors';
import { errorResponse, ErrorCode, resolveFormat, SubsonicError } from '@edge-sonic/subsonic';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';

type RateLimitContext = UserContext;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * The one trusted client address in this app.
 *
 * Trust order is deliberately a single entry: Cloudflare sets `CF-Connecting-IP` and
 * it cannot be spoofed by a client. `X-Forwarded-For`, `x-real-ip`, and every other
 * forwarding header are **not** consulted, because they are client-controlled and let
 * an attacker rotate buckets — or, on the `/rest` path, rotate the identity keying a
 * D1-backed *fail-closed* credential throttle at will. Local dev without CF headers
 * shares the `unknown` bucket, which is fail-closed grouping rather than
 * per-spoofed-header isolation.
 *
 * Takes a header reader rather than a Hono context so the `/rest` dispatcher, which
 * has a bare `Request` rather than a context, uses the same derivation.
 */
function clientIp(header: (name: string) => string | undefined): string {
  return header('CF-Connecting-IP')?.trim() || 'unknown';
}

function getRateLimitBucketCountForTests(): number {
  return buckets.size;
}

function evictOldestBucket(): void {
  let oldestReset = Infinity;
  for (const [, bucket] of buckets) {
    oldestReset = Math.min(oldestReset, bucket.resetAt);
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt === oldestReset) {
      buckets.delete(key);
      break;
    }
  }
}

/**
 * Upper bound on tracked buckets.
 *
 * Every distinct key costs memory for the isolate's lifetime, so an attacker
 * rotating keys (a spoofable `X-Forwarded-For` would allow exactly that) would
 * otherwise grow the map without limit.
 */
const MAX_BUCKETS = 5000;

function cleanup(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Evict the oldest-resetting bucket rather than clearing the map, so an
  // attacker flooding new keys cannot wipe out everyone else's buckets.
  //
  // Evict down to `MAX_BUCKETS - 1` because the caller adds its own bucket
  // immediately afterwards; evicting to exactly `MAX_BUCKETS` let the map reach
  // `MAX_BUCKETS + 1` before the next cleanup.
  let overflow = buckets.size - (MAX_BUCKETS - 1);
  while (overflow > 0) {
    evictOldestBucket();
    overflow -= 1;
  }
}

/**
 * Minimal in-memory token-bucket guard for abuse-prone endpoints.
 *
 * Per-isolate only (Workers have no shared memory). The router has no cron
 * triggers and no Durable Objects, so there is no cross-isolate backstop: this
 * bounds abuse per isolate and nothing more. Never throws at request time —
 * failures fail open so limiting can never 500 a legitimate request.
 * IP grouping is fail-closed: without a trusted CF-Connecting-IP all callers
 * share the `unknown` bucket instead of getting per-spoofed-header isolation.
 *
 * Breaking: misconfigured `opts` (non-positive windowMs/max, empty keyPrefix)
 * now throw at registration time instead of silently installing an unlimited
 * or immediately-tripping bucket. All shipped `RATE_LIMIT_DEFS` are valid.
 *
 * ### `max` may be a resolver, and why that is the only honest shape
 *
 * A budget read from the environment cannot be resolved at registration time: the route
 * table is built once in the constructor, where `env` does not exist, so a `STREAM_RATE_LIMIT`
 * read there would be a module-level constant wearing a variable's name. That is how the
 * variable came to be declared, validated, shipped in the template and read by nothing while
 * the limiter used a literal — the knob was real and the code was not reading it.
 *
 * A resolver is evaluated per request from `c.env`, which is also the only place the value
 * can differ from the module-level one. The static check below is skipped for a resolver,
 * because a limiter that throws *while being installed* takes down every route it was
 * attached to; an unusable answer is caught per request instead, by {@link resolveBudget}.
 */
/**
 * The budget to enforce for this request.
 *
 * A resolver that throws must not produce an *unlimited* bucket: `count >= NaN` is false,
 * so a broken resolver silently turns the limiter **off** rather than off-by-a-lot — the
 * direction nobody notices. So the call is guarded, and a throw propagates to the
 * limiter's own fail-open path rather than to a bucket check that no longer bounds anything.
 *
 * The value is only ever what the resolver returned; deciding what an *unusable* value
 * falls back to belongs to whoever supplied the resolver, because only they know the limit's
 * own default. `rateLimitConfig` reads `STREAM_RATE_LIMIT` through `EnvParser`, which
 * already fails soft to `def.max`.
 */
function resolveBudget(max: number | ((c: RateLimitContext) => number), c: RateLimitContext): number {
  if (typeof max === 'number') return max;
  const resolved = max(c);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`Invalid rateLimit budget: ${String(resolved)} (must be a positive integer)`);
  }
  return resolved;
}

function rateLimit(opts: {
  windowMs: number;
  max: number | ((c: RateLimitContext) => number);
  keyPrefix: string;
  surface: 'rest' | 'user';
}): (c: RateLimitContext, next: Next) => Promise<Response | void> {
  if (!Number.isSafeInteger(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error(`Invalid rateLimit windowMs: ${String(opts.windowMs)} (must be a positive integer)`);
  }
  if (typeof opts.max === 'number' && (!Number.isSafeInteger(opts.max) || opts.max <= 0)) {
    throw new Error(`Invalid rateLimit max: ${String(opts.max)} (must be a positive integer)`);
  }
  if (!opts.keyPrefix || opts.keyPrefix.trim().length === 0) {
    throw new Error('Invalid rateLimit keyPrefix: must be a non-empty string');
  }
  return async (c: RateLimitContext, next: Next): Promise<Response | void> => {
    try {
      const now = Date.now();
      cleanup(now);
      // Resolved by a helper so the two unusable answers — a resolver that throws, and one
      // that answers a non-positive-integer — are rejected in one place. This `try` then
      // fails open with `await next()`, which is the documented behaviour for anything the
      // limiter cannot do: a request must not fail because limiting could not size itself.
      const max = resolveBudget(opts.max, c);
      // `AuthenticatedUserEmailAddress` is the resolved Cloudflare Access identity, so a
      // bucket is per operator rather than per address. It is only set when this
      // middleware runs *after* `userAuthentication`, which is why that ordering is
      // load-bearing: a limiter registered before the identity exists silently degrades
      // to `ip:…`, and every operator behind one NAT shares a budget.
      let identity = 'anon';
      try {
        identity = c.get('AuthenticatedUserEmailAddress') ?? `ip:${clientIp((name) => c.req.header(name))}`;
      } catch {
        identity = `ip:${clientIp((name) => c.req.header(name))}`;
      }
      const key = `${opts.keyPrefix}:${identity}`;
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        await next();
        return;
      }
      if (existing.count >= max) {
        const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        // One surface, one dialect — and this middleware installs on **both**.
        //
        // `/rest` answers in the Subsonic envelope, which is what makes the 429 usable: a
        // Subsonic client parses `subsonic-response` and nothing else, so a 429 carrying
        // the user API's `{error:{…}}` body reaches it as "server error" and it retries
        // immediately, which is the opposite of what a throttle is for. `throttled: true`
        // is also the only thing that has ever reached `errorResponse`'s throttle branch —
        // it was dead, so the status on this surface was whatever the envelope said.
        //
        // `/user` keeps the canonical error type, so its wire body cannot drift from the
        // mapping every other user error goes through.
        if (opts.surface === 'rest') {
          const throttled = errorResponse(
            new SubsonicError(ErrorCode.Generic, `Too many requests. Retry after ${retryAfter}s.`),
            { format: resolveFormat(c.req.query('f')), jsonpCallback: c.req.query('callback') ?? null },
            true,
          );
          // The interval travels on the header as well as in the message: a client that
          // only reads the status has no other way to know how long to wait, and one that
          // retries immediately is the failure a throttle exists to prevent.
          throttled.headers.set('Retry-After', String(retryAfter));
          return throttled;
        }
        const limited = new RateLimitedError();
        return c.json(BaseRoute.toErrorBody(limited.getErrorCode(), limited.getErrorMessage()), limited.getErrorCode() as 429, {
          // A client that is told "slow down" without being told how long to wait
          // either retries immediately or gives up on the surface.
          'Retry-After': String(retryAfter),
        });
      }
      existing.count += 1;
      await next();
    } catch {
      await next();
    }
  };
}

function resetRateLimitForTests(): void {
  buckets.clear();
}

export { rateLimit, resetRateLimitForTests, clientIp, getRateLimitBucketCountForTests };
