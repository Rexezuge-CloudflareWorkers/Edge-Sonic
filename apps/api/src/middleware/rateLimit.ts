import type { Next } from 'hono';
import { RateLimitedError } from '@edge-sonic/backend-errors';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { AdminContext } from '../endpoints/BaseRoute';

type RateLimitContext = AdminContext;

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
 */
function rateLimit(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}): (c: RateLimitContext, next: Next) => Promise<Response | void> {
  if (!Number.isSafeInteger(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error(`Invalid rateLimit windowMs: ${String(opts.windowMs)} (must be a positive integer)`);
  }
  if (!Number.isSafeInteger(opts.max) || opts.max <= 0) {
    throw new Error(`Invalid rateLimit max: ${String(opts.max)} (must be a positive integer)`);
  }
  if (!opts.keyPrefix || opts.keyPrefix.trim().length === 0) {
    throw new Error('Invalid rateLimit keyPrefix: must be a non-empty string');
  }
  return async (c: RateLimitContext, next: Next): Promise<Response | void> => {
    try {
      const now = Date.now();
      cleanup(now);
      // `AdminEmail` is the resolved Cloudflare Access identity, so a bucket is per
      // operator rather than per address. It is only set when this middleware runs
      // *after* `adminAuthentication`, which is why that ordering is load-bearing: a
      // limiter registered before the identity exists silently degrades to `ip:…`, and
      // every operator behind one NAT shares a budget.
      let identity = 'anon';
      try {
        identity = c.get('AdminEmail') ?? `ip:${clientIp((name) => c.req.header(name))}`;
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
      if (existing.count >= opts.max) {
        const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        // The canonical error type, so the wire envelope cannot drift from the mapping
        // every other admin error goes through. Hand-building the JSON here is how this
        // response came to be the one admin error in a second dialect.
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
