/**
 * Detecting a sign-in that changed nothing.
 *
 * ### The loop this exists to name
 *
 * The landing page's only call to action navigates to `/user/`, which is inside the
 * Cloudflare Access application. That is the whole mechanism — there is no login form
 * here to fail, and nothing to validate before the navigation.
 *
 * So a deployment with **no Access application in front of it** produces this:
 * `/` serves the landing page → the operator clicks Sign In → `/user/` hits the
 * worker, which redirects to `/` → the SPA mounts and reads `/user/me` → 401 → the
 * landing page again. Every click is a real navigation and every one lands on the same
 * page, so the operator is offered a button that has been pressed and did nothing.
 *
 * That is the *only* symptom. Before this module the page said "Sign in with Cloudflare
 * Access" and nothing else, which is indistinguishable from a user who has not clicked
 * it yet — the same reason a scan that stops at a bound has to name the bound.
 *
 * ### Why the client cannot be told, and must not ask
 *
 * `AccessAuthService` throws **one** `UnauthorizedError` for a missing session and for
 * a missing `TEAM_DOMAIN`/`POLICY_AUD`, because the JWT strategy fails soft at
 * `fromJwt` and the configuration cause is discarded before the single throw site. That
 * collapse is deliberate: every JWT failure reads "Cloudflare Access authentication
 * failed" because a detailed one tells an unauthenticated caller which part of the token
 * they got right.
 *
 * So both arrive as `401 / Exception.Type === 'Unauthorized'` and **no client can tell
 * them apart.** The honest move is not to invent a distinction the server refuses to
 * make, but to detect the *observable* fact — the operator already navigated to sign in,
 * and is still anonymous — and say what that implies. It is a stronger inference than
 * guessing at the cause: it is the loop itself, witnessed.
 *
 * ### `sessionStorage`, not module state
 *
 * The navigation is a full page load, so nothing in memory survives it. A module-level
 * variable would be `false` on the load that matters and the hint would never appear.
 * `sessionStorage` rather than `localStorage` because the fact is about *this* browsing
 * session — a login that worked last week says nothing about whether this click did
 * anything.
 */

const STORAGE_KEY = 'edge-sonic-sign-in-attempted';

/**
 * Record that the operator asked to sign in.
 *
 * Best-effort: `sessionStorage` throws in private browsing modes and when a quota is
 * exhausted, and a storage failure must not stop the navigation that was requested —
 * losing the hint is the acceptable outcome, not a broken button.
 */
function rememberSignInAttempt(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, '1');
  } catch {
    // Ignore: the sign-in still proceeds, only the diagnosis is lost.
  }
}

/**
 * Whether this page load is the *second* one in a sign-in that has not yet succeeded.
 *
 * Read rather than written on the far side, so the flag has exactly one writer — the
 * button that performs the navigation — and cannot be set by anything that did not
 * navigate.
 */
function hasPriorSignInAttempt(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Clear the record once a session is established.
 *
 * Called on success, not on the next render: an operator who signs in successfully and
 * is later signed out by an expired cookie is an ordinary signed-out visitor again, and
 * telling them their Access configuration is broken would be sending them to debug a
 * deployment that works.
 */
function clearSignInAttempt(): void {
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

export { STORAGE_KEY as SIGN_IN_ATTEMPT_KEY, rememberSignInAttempt, hasPriorSignInAttempt, clearSignInAttempt };
