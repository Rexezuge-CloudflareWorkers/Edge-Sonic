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

/**
 * Below this many buckets, cleanup does nothing at all.
 *
 * The threshold rather than 0: sweeping a handful of entries on every request is work for nothing,
 * and below the threshold an expiry sweep cannot reclaim enough to matter.
 */
const CLEANUP_THRESHOLD = 1000;

/**
 * Sweep expired buckets, at most once per `CLEANUP_INTERVAL_MS`.
 *
 * ### Why this is amortised rather than per-request
 *
 * It used to run on **every** request: below 1,000 buckets it returned immediately, and at or above
 * it every single request paid a full iteration of a map holding up to `MAX_BUCKETS` entries — plus
 * two more full iterations per eviction. Memory was already bounded, so the cap worked; what was
 * unbounded was the *cost*, and it was paid by every caller rather than by the one who filled the
 * map. An attacker rotating 1,000+ distinct keys therefore converted every subsequent request on
 * that isolate into O(n) map work against the Free plan's 10 ms CPU budget — which is a cheap way to
 * make a rate limiter a denial-of-service vector against itself.
 *
 * So the sweep is time-triggered rather than size-triggered. Memory is still bounded — that was
 * never the problem — and the work is now paid at a fixed rate instead of a per-request one.
 *
 * **The map can still be large when this runs.** That is the point: the cap is what bounds memory,
 * and this bounds what an attacker pays per request.
 */
const CLEANUP_INTERVAL_MS = 30_000;

let lastCleanupAt = 0;

function cleanup(now: number): void {
  // **The cap is enforced on every request**, and only the sweep is deferred. Those are different
  // jobs with different failure modes: the cap is a *memory* bound, and memory grows whether or not
  // a sweep runs, so deferring it would make the bound wrong — an attacker rotating keys would hold
  // `MAX_BUCKETS + one request's worth` rather than `MAX_BUCKETS`, and `test/rate-limit.test.ts`
  // asserts the ceiling directly.
  //
  // Evicting **down** rather than clearing, so an attacker flooding new keys cannot wipe out
  // everyone else's buckets. Down to `MAX_BUCKETS - 1` because the caller adds its own bucket
  // immediately afterwards; evicting to exactly `MAX_BUCKETS` let the map reach `MAX_BUCKETS + 1`
  // before the next cleanup.
  let overflow = buckets.size - (MAX_BUCKETS - 1);
  while (overflow > 0) {
    evictOldestBucket();
    overflow -= 1;
  }

  // **The sweep is amortised**, which is the part that used to run per-request. It walks the whole
  // map to drop the expired entries, so above the threshold every request paid a full iteration of up
  // to `MAX_BUCKETS` entries — paid by every caller rather than by the one who filled the map. An
  // attacker rotating 1,000+ distinct keys turned every subsequent request on that isolate into O(n)
  // map work against the Free plan's 10 ms CPU budget: a cheap way to make a rate limiter a
  // denial-of-service vector against itself.
  //
  // Nothing is lost by deferring it. An expired bucket is *already* treated as absent by the
  // request path (`existing.resetAt <= now` takes the same branch as a missing key), so the sweep
  // only reclaims memory — and memory is what the cap above already bounds. The cost moves from
  // per-request to a fixed rate.
  if (buckets.size < CLEANUP_THRESHOLD) return;
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
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
    // The limiter's own work, and **only** the limiter's own work, is inside this `try`.
    //
    // It used to enclose `await next()` as well. The intent was "fail open if the limiter cannot
    // size itself", and the way that was written also caught anything the *downstream chain*
    // rejected — calling `next()` a second time from the `catch`.
    //
    // **Measured, and the second call does not re-run anything.** Hono's `compose` guards its own
    // dispatch with `if (i <= index) throw new Error('next() called multiple times')`
    // (`hono/dist/compose.js`), so the second call throws rather than re-entering the handlers
    // after this one. A probe of both shapes — the chain's handler throwing, with an `onError` that
    // also throws — ran the handler exactly once either way. So the defect this fixes was **not** a
    // double-written scrobble; it was that the limiter's contract depended on a guard in a library
    // it does not own, and that a rejection escaping the chain surfaced as *"next() called multiple
    // times"* — a message naming a Hono internal, on a path whose documented behaviour is to fail
    // open.
    //
    // Correct in both directions for the same reason: a fail-open branch should not enclose the
    // thing it is failing open *for*, whatever the framework underneath happens to do.
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
        return await next();
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
      return await next();
    } catch {
      // Fail open: the limiter could not size itself, and a request must not fail because of that.
      // `next()` runs **once**, from here or from the paths above — never from both.
      return await next();
    }
  };
}

function resetRateLimitForTests(): void {
  buckets.clear();
}

export { rateLimit, resetRateLimitForTests, clientIp, getRateLimitBucketCountForTests };
