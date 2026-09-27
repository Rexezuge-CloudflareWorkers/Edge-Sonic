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
import { rateLimit } from './rateLimit';

interface RateLimitDef {
  path: string;
  windowMs: number;
  max: number;
  keyPrefix: string;
  /**
   * Why this budget exists. Recorded so the table can be tuned without archaeology.
   */
  reason: string;
}

const RATE_LIMIT_DEFS: readonly RateLimitDef[] = [
  {
    path: '/rest/stream*',
    windowMs: 60_000,
    max: 600,
    keyPrefix: 'stream',
    reason: 'Range requests multiply: one 5-minute track is a handful of seeks, so this must not be a per-request-tight budget.',
  },
  {
    path: '/rest/download*',
    windowMs: 60_000,
    max: 60,
    keyPrefix: 'download',
    reason: 'A whole-file fetch is unbounded egress, unlike a range.',
  },
  {
    path: '/rest/getCoverArt*',
    windowMs: 60_000,
    max: 300,
    keyPrefix: 'coverart',
    reason: 'Clients request artwork per grid cell, so it is high-frequency but small.',
  },
  {
    path: '/rest/getScanStatus*',
    windowMs: 60_000,
    max: 120,
    keyPrefix: 'scanstatus',
    reason: 'Polling drives the scan, so it is capped — but generously, because a client legitimately polls during a scan.',
  },
  {
    path: '/admin/*',
    windowMs: 60_000,
    max: 60,
    keyPrefix: 'admin',
    reason: 'Probe and rescan actions perform live outbound requests with a stored credential.',
  },
];

function registerRateLimits(app: Hono<{ Bindings: Cloudflare.Env; Variables: { AdminEmail: string } }>): void {
  for (const def of RATE_LIMIT_DEFS) {
    app.use(def.path, rateLimit({ windowMs: def.windowMs, max: def.max, keyPrefix: def.keyPrefix }));
  }
}

export { RATE_LIMIT_DEFS, registerRateLimits };
export type { RateLimitDef };
