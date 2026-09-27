/**
 * Cloudflare Access guard for the **admin API only**.
 *
 * `/rest/*` does not come through here: a Subsonic client can only present
 * `u`/`t`/`s`, so it is authenticated by `SubsonicAuthService` against the `users`
 * table. Keeping the two identity systems separate is a security property — an
 * operator's Access identity must not double as a streaming credential.
 */
import type { Next } from 'hono';
import { AccessAuthService } from '@edge-sonic/backend-services/auth';
import type { AccessIdentityContext } from '@edge-sonic/backend-services/auth';
import { ErrorSanitizationUtil } from '@edge-sonic/shared/utils';
import { BaseRoute } from '../admin/routes';
import type { AdminContext } from '../admin/routes';

async function adminAuthenticationHandler(c: AdminContext, next: Next): Promise<Response | void> {
  try {
    const email = await new AccessAuthService(c.env).getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
    c.set('AdminEmail', email);
  } catch (error) {
    // An authentication failure is expected; anything else is a bug and is logged
    // with its cause. Both answer with the admin API's own error shape, because
    // this is a JSON surface whose client — the SPA — reads the status.
    if (!(error instanceof Error) || error.name !== 'ServiceError') {
      console.error('adminAuthentication failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    return BaseRoute.toErrorResponse(c, error);
  }
  await next();
}

function adminAuthentication(): (c: AdminContext, next: Next) => Promise<Response | void> {
  return adminAuthenticationHandler;
}

export { adminAuthentication, adminAuthenticationHandler };
