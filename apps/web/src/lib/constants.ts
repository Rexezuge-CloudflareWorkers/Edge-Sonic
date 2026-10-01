export const NOTICE_TIMEOUT_MS = 6000;

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