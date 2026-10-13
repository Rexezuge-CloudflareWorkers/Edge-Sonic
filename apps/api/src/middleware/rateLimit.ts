/**
 * The per-isolate rate limiter, over the kit's engine.
 *
 * ### One surface, one dialect — and this is where the surface's dialect lives
 *
 * The kit's `rateLimit` emits the family's canonical
 * `{Exception:{Type,Message}}` 429 and hands a second dialect the same question
 * through `onThrottled`. That split is the right shape: the kit has one envelope,
 * so a caller whose clients parse a different one says so at the call site rather
 * than the limiter deciding for it. The `surface` field this file used to carry
 * was the kit's own — and never read, because the kit has exactly one dialect to
 * choose from and a declared-but-ignored field reads as "set this and the limiter
 * knows what to do".
 *
 * So `rateLimit` below is a thin wrapper that adds exactly one thing: it reads the
 * surface and supplies the matching envelope. The arithmetic, the registration
 * guards, the fail-open, the bucket map and the eviction are the kit's.
 *
 * ### The `/rest` dialect, and why it is not the user API's
 *
 * A Subsonic client parses `subsonic-response` and nothing else, so a 429 carrying
 * the user API's `{error:{…}}` body reaches it as "server error" and it retries
 * immediately, which is the opposite of what a throttle is for. `throttled: true` is
 * also the only thing that reaches `errorResponse`'s throttle branch.
 *
 * `/user` keeps the canonical error type, so its wire body cannot drift from the
 * mapping every other user error goes through.
 */
import { rateLimit as kitRateLimit } from '@rexezuge/http';
import type { RateLimitContext, RateLimitHandler } from '@rexezuge/http';
import type { Next } from 'hono';
import { RateLimitedError } from '@rexezuge/errors';
import { SubsonicError, ErrorCode, errorResponse, resolveFormat } from '@edge-sonic/subsonic';
import { BaseRoute } from '../endpoints/BaseRoute';

type Surface = 'rest' | 'user';

interface RateLimitOptions {
  windowMs: number;
  max: number | ((c: RateLimitContext) => number);
  keyPrefix: string;
  /**
   * Which dialect a 429 on this limiter answers in. Required rather than
   * defaulted: a limiter that guesses picks one of two envelopes for a surface
   * whose clients parse the other, and the failure is a client retrying a throttle
   * immediately.
   */
  surface: Surface;
}

/**
 * Build the 429 for one surface.
 *
 * Named rather than inlined because `test/rate-limit.test.ts` asserts that a
 * throttled `/rest` request is a 429 carrying a `subsonic-response status="failed"`
 * envelope with an `error.code` and **no** `Exception` — the one branch that used
 * to be dead in the suite while being live in the product.
 */
function throttledFor(surface: Surface, retryAfter: number, c: RateLimitContext): Response {
  if (surface === 'rest') {
    return errorResponse(
      new SubsonicError(ErrorCode.Generic, `Too many requests. Retry after ${retryAfter}s.`),
      { format: resolveFormat(c.req.query?.('f')), jsonpCallback: c.req.query?.('callback') ?? null },
      true,
    );
  }
  const limited = new RateLimitedError();
  return c.json(BaseRoute.toErrorBody(limited.status, limited.message), limited.status);
}

function rateLimit(opts: RateLimitOptions): (c: RateLimitContext, next: Next) => Promise<Response | void> {
  const handler: RateLimitHandler = kitRateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    keyPrefix: opts.keyPrefix,
    onThrottled: (retryAfter, c) => throttledFor(opts.surface, retryAfter, c),
  });
  return handler;
}

export { rateLimit };
export { clientIp, getRateLimitBucketCountForTests, resetRateLimitForTests, type RateLimitContext } from '@rexezuge/http';
