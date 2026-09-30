/**
 * Table-driven rate-limit registry.
 *
 * All buckets are **per-isolate token buckets** and every one **fails open**: a
 * rate limiter that fails closed takes down playback for every user when its own
 * in-memory state is cold, which is exactly what happens on a fresh isolate after a
 * deploy. These limits are a speed bump against abuse, not a security control.
 *
 * ### The authentication control is elsewhere, and deliberately different
 *
 * `SubsonicAuthService`'s failure counter is **D1-backed and fails closed**, because
 * the threat it defends against is an attacker who is already being turned away, and
 * an unreadable counter means the server has no idea how many attempts it has
 * absorbed. Two limiters with opposite failure semantics in one codebase is correct
 * — they defend against different things — and confusing them would be a bug.
 */
import type { Hono } from 'hono';
import { AppConfiguration, DEFAULT_STREAM_RATE_LIMIT } from '@edge-sonic/backend-runtime/config';
import { rateLimit } from './rateLimit';

/**
 * Which authenticated surface a definition belongs to.
 *
 * The split is a **field**, not an array index. The reference project slices
 * `RATE_LIMIT_DEFS.slice(0, 3)` / `.slice(3)`, which means inserting a definition at
 * index 3 silently reclassifies it — a new `/rest` limit would become a user limit
 * and start being keyed on the wrong identity. A field cannot drift that way.
 */
type LimitSurface = 'rest' | 'user';

interface RateLimitDef {
  path: string;
  windowMs: number;
  max: number;
  keyPrefix: string;
  surface: LimitSurface;
  /**
   * Why this budget exists. Recorded so the table can be tuned without archaeology.
   */
  reason: string;
}

const RATE_LIMIT_DEFS: readonly RateLimitDef[] = [
  {
    path: '/rest/stream*',
    windowMs: 60_000,
    // A literal, because this table is a module-level `const` and the environment is not
    // in scope there. `install` replaces it with a resolver over `c.env` — see below for
    // why that is the only honest shape and what happened when this was just the number.
    max: Number(DEFAULT_STREAM_RATE_LIMIT),
    keyPrefix: 'stream',
    surface: 'rest',
    reason: 'Range requests multiply: one 5-minute track is a handful of seeks, so this must not be a per-request-tight budget.',
  },
  {
    path: '/rest/download*',
    windowMs: 60_000,
    max: 60,
    keyPrefix: 'download',
    surface: 'rest',
    reason: 'A whole-file fetch is unbounded egress, unlike a range.',
  },
  {
    path: '/rest/getCoverArt*',
    windowMs: 60_000,
    max: 300,
    keyPrefix: 'coverart',
    surface: 'rest',
    reason: 'Clients request artwork per grid cell, so it is high-frequency but small.',
  },
  {
    path: '/rest/getScanStatus*',
    windowMs: 60_000,
    max: 120,
    keyPrefix: 'scanstatus',
    surface: 'rest',
    reason: 'Polling drives the scan, so it is capped — but generously, because a client legitimately polls during a scan.',
  },
  {
    path: '/user/*',
    windowMs: 60_000,
    max: 60,
    keyPrefix: 'user',
    surface: 'user',
    reason: 'Probe and rescan actions perform live outbound requests with a stored credential.',
  },
];

type LimitApp = Hono<{ Bindings: Cloudflare.Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function install(app: LimitApp, def: RateLimitDef): void {
  app.use(
    def.path,
    rateLimit({
      windowMs: def.windowMs,
      // Read through the request's own configuration, which is the only place `env`
      // exists at request time. The alternative — a module-level constant named
      // `STREAM_RATE_LIMIT` — is what made the variable look configured while nothing
      // read it.
      max: def.keyPrefix === 'stream' ? (c) => AppConfiguration.fromEnv(c.env).getStreamRateLimit() : def.max,
      keyPrefix: def.keyPrefix,
      surface: def.surface,
    }),
  );
}

/**
 * `/rest/*`. Keyed on the client address, because a Subsonic client authenticates
 * per request and there is no ambient identity on this surface.
 *
 * Registered **before** `app.all('/rest/*')` — so before the router, not after it. The
 * consequence the comment used to get right is that the limiter wraps the dispatcher
 * rather than running inside it; the sentence describing *when* was inverted, and the
 * inversion is the kind that gets "fixed" the wrong way by a reader who trusts the prose.
 * `test/security-headers.test.ts` asserts both registrars are callable and nothing about
 * their position, because their position is a property of `EdgeSonicWorker`'s route order
 * and only that file can see it.
 */
function registerRestRateLimits(app: LimitApp): void {
  for (const def of RATE_LIMIT_DEFS) {
    if (def.surface === 'rest') install(app, def);
  }
}

/**
 * `/user/*`. Registered **after** `userAuthentication`, so the bucket can be keyed
 * on the resolved Access identity rather than only on an address that every operator
 * behind one NAT shares. This ordering is load-bearing; see the worker's route order.
 */
function registerUserRateLimits(app: LimitApp): void {
  for (const def of RATE_LIMIT_DEFS) {
    if (def.surface === 'user') install(app, def);
  }
}

export { RATE_LIMIT_DEFS, registerRestRateLimits, registerUserRateLimits };
export type { RateLimitDef, LimitSurface };
