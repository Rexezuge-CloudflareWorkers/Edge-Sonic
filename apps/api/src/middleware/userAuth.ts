/**
 * Cloudflare Access guard for the **user API only**.
 *
 * `/rest/*` does not come through here: a Subsonic client can only present
 * `u`/`t`/`s`, so it is authenticated by `SubsonicAuthService` against the `users`
 * table. Keeping the two identity systems separate is a security property — an
 * operator's Access identity must not double as a streaming credential.
 *
 * Authz stays operator-only under `/user/*`: authentication proves *who* the caller
 * is, and every route on this surface is an operator action (libraries, users, scans).
 * The path matches the reference project; the authorization model does not change with
 * it.
 *
 * The service comes from the request scope like every other service, so it shares the
 * scope's one `AppConfiguration` and is reachable from a test that wants a stub. It is
 * resolved through `BaseRoute.getScope`, which also works for a handler driven outside
 * the middleware ordering.
 */
import type { Next } from 'hono';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { ErrorSanitizationUtil } from '@edge-sonic/shared/utils';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';

async function userAuthenticationHandler(c: UserContext, next: Next): Promise<Response | void> {
  try {
    // Only the request is passed. The `ACCESS` binding rides on `env`, which the scope
    // already holds — it is a binding, not a property of the execution context, and
    // reading it off `c.executionCtx` is a branch that can never resolve.
    const email = await BaseRoute.getScope(c).get(Tokens.AccessAuthService).getAuthenticatedUserEmail(c.req.raw);
    c.set('AuthenticatedUserEmailAddress', email);
  } catch (error) {
    // An authentication failure is expected; anything else is a bug and is logged
    // with its cause. Both answer with the user API's own error shape, because
    // this is a JSON surface whose client — the SPA — reads the status.
    if (!(error instanceof Error) || error.name !== 'ServiceError') {
      console.error('userAuthentication failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    return BaseRoute.toErrorResponse(c, error);
  }
  await next();
}

function userAuthentication(): (c: UserContext, next: Next) => Promise<Response | void> {
  return userAuthenticationHandler;
}

export { userAuthentication, userAuthenticationHandler };
