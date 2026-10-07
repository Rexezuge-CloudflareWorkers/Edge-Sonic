import type { Next } from 'hono';
import { asScopedContext, setRequestScope } from '@edge-sonic/backend-runtime/di';
import { createRequestScope, Tokens } from '@edge-sonic/backend-services/composition';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';
import { getScanStub, hasScanBinding } from '../workers/scanStubs';
import { resolveScanDriver } from '../workers/scanDriver';
import { resolveEnrichDriver } from '../workers/enrichDriver';
import { READER_VERSION } from '@edge-sonic/media-tags';

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
 *
 * ### The `ScanDriver` is resolved **here**, once, for the same reason
 *
 * Because "is a Durable Object carrying this scan?" is a property of the deployment and was
 * being asked at seven sites — two of which disagreed about what the same question meant. This is
 * the one place both halves are visible, so it is the one place the answer is decided.
 *
 * It is passed rather than left to `createRequestScope`'s default because the default is the
 * **in-process** strategy, which is right for a scope with no binding and wrong for this one: the
 * default is chosen by Layer 3, which cannot see whether a binding exists.
 */
async function scopeMiddleware(c: ScopeContext, next: Next): Promise<Response | void> {
  const meterOf = (): SubrequestMeter => BaseRoute.getScope(c).get(Tokens.SubrequestMeter);
  setRequestScope(
    asScopedContext(c),
    createRequestScope(
      c.env,
      (libraryId) => (hasScanBinding(c.env) ? getScanStub(c.env, libraryId, meterOf()) : null),
      // Built here, because this is the one place both halves are visible. The `ScanService` is a
      // thunk read out of the scope being constructed, so the driver and the scope cannot end up on
      // different graphs — and two graphs would mean two `SubrequestCounter`s.
      resolveScanDriver(c.env, () => BaseRoute.getScope(c).get(Tokens.ScanService), meterOf()),
      // The enrichment run's driver, decided the same way and for the same reason. A separate
      // decision because the loops are separate: one predicate for both would let a deployment
      // with a scan object and no enrich object advance an enrichment through the scan's.
      resolveEnrichDriver(
        c.env,
        () => BaseRoute.getScope(c).get(Tokens.LibraryEnrichmentService),
        async (libraryId) => (await BaseRoute.getScope(c).get(Tokens.SongEnrichmentDAO)()).countNeedingEnrichment(libraryId, READER_VERSION),
        meterOf(),
      ),
    ),
  );
  await next();
}

export { scopeMiddleware };
