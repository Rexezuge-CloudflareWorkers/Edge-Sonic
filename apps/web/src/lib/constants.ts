export const NOTICE_TIMEOUT_MS = 6000;

/**
 * How often the operator page re-reads the library list while something is scanning.
 *
 * Sized against a budget that is easy to forget exists: `/user/*` is rate-limited to **60
 * requests per minute** keyed on the Access identity (`RATE_LIMIT_DEFS` in `apps/api`). One
 * poll per tick of the libraries endpoint is 12 requests a minute at this interval, so an
 * operator watching a scan keeps a large majority of the bucket free for the actions they
 * will actually want — probe, rescan, edit.
 *
 * It is a poll of `GET /user/libraries`, which is **passive**: it reads `scan_state` and
 * `songs` and advances nothing. So the interval is a *display* cadence and not a claim about
 * how fast a scan progresses — with no `SCAN` Durable Object binding configured, the scan is
 * advanced by `/rest/getScanStatus` and by the operator's own rescan, and polling this page
 * faster would change nothing but the request count.
 */
export const SCAN_POLL_INTERVAL_MS = 5000;

/**
 * The sign-in target for the landing page and the `Unauthorized` gate.
 *
 * It exists for one reason: this path is inside the Cloudflare Access application,
 * so navigating there starts the login flow. There is nothing to implement here and
 * nothing to redirect to — `/user/*` is the operator API, not a page.
 *
 * ### Why the worker also registers `/user/`
 *
 * Access redirects back to the URL it interrupted, so after a *successful* sign-in
 * the browser arrives at `/user/` and the worker answers. With no route for it that
 * is a JSON `Exception{NotFound}` — the one screen in this product guaranteed to be
 * reached by an operator who did exactly what the landing page asked. So
 * `EdgeSonicWorker` registers `/user/` as a redirect to `/`, and this constant names
 * the entry to that redirect rather than being the whole mechanism.
 */
export const ZERO_TRUST_AUTHENTICATION_PATH = '/user/';
