import type { Next } from 'hono';
import { asScopedContext, setRequestScope } from '@edge-sonic/backend-runtime/di';
import { createRequestScope, Tokens } from '@edge-sonic/backend-services/composition';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';
import { getScanStub, hasScanBinding } from '../workers/scanStubs';

type ScopeContext = UserContext;

/**
 * Single-scope-per-request middleware (Otter composition-root pattern).
 * Creates one `Container` per request and stores it on the Hono context.
 * Handlers resolve via `getRequestScope(c)` instead of calling
 * `createRequestScope(c.env)` per handler (which minted N scopes per request
 * and defeated singleton memoization).
 *
 * ### The scan stub resolver, and why it is built here
 *
 * `IndexDropService` needs to reach each library's `ScanWorker` — to delete its alarm before
 * the index is dropped, and to charge it for what the drop billed. Reaching a Durable Object
 * means a namespace stub, which is `apps/api`'s business and not something Layer 3 may
 * construct, so the resolver is a **parameter** of the composition root and this middleware is
 * the one place both halves are visible.
 *
 * The meter is read through `getScope` **lazily**, inside the resolver, rather than being
 * closed over at construction: the scope holding it does not exist yet on the line above.
 * Reading it per call is also what keeps a fallback scope from handing this a budget of its
 * own — the same argument `meterOf` makes in `user/routes.ts`.
 */
async function scopeMiddleware(c: ScopeContext, next: Next): Promise<Response | void> {
  const meterOf = (): SubrequestMeter => BaseRoute.getScope(c).get(Tokens.SubrequestMeter);
  setRequestScope(
    asScopedContext(c),
    createRequestScope(c.env, (libraryId) => (hasScanBinding(c.env) ? getScanStub(c.env, libraryId, meterOf()) : null)),
  );
  await next();
}

export { scopeMiddleware };
