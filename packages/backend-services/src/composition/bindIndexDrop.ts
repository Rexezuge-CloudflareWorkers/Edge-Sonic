/**
 * The Danger Zone's binding, out of `requestScope.ts`.
 *
 * ### Why this is its own module
 *
 * Because `requestScope.ts` is over the god-file limit and this is a cohesive block that did
 * not exist when it was written. That is the same reason `songCounts.ts` came out of
 * `SongDAO.ts` and `librarySummary.ts` came out of `apps/api/src/user/routes.ts` — the answer
 * to a file that has outgrown its shape is to move the block that does not belong, not to
 * shorten the reasoning in the blocks that do.
 *
 * What moves here is the **wiring** for one feature. The decisions stay where they are
 * reachable: what a drop destroys and why the annotations survive is `IndexDropDAO`'s comment,
 * what it costs and in what order the scan object is stopped is `IndexDropService`'s.
 *
 * ### Why `scanFor` is a parameter and not read off `env`
 *
 * A layer boundary rather than a convenience. Reaching a Durable Object means a namespace
 * stub, and constructing one is `apps/api`'s business — Layer 3 cannot see `DurableObjectNamespace`
 * as anything but `unknown` on `RequestScopeEnv`. So the caller passes a resolver and this
 * module stays ignorant of where a stub comes from.
 *
 * It is **optional**, and both other callers omit it: `ScanWorkerFactory` is a Durable Object
 * that cannot RPC itself and a scan never drops an index, and `apps/api` is the only place a
 * stub exists. Absent, the drop still works — the D1 deletes are the whole point of the
 * operation — and there is simply no alarm to stop and no day-counter to charge, which is the
 * honest outcome on a deployment with no `SCAN` binding rather than a `TypeError` from a stub
 * the caller never supplied.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import { IndexDropDAO, IndexStatsDAO } from '@edge-sonic/backend-data/dao';
import type { D1Queryable } from '@edge-sonic/backend-data/utils';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { IndexDropService } from '../library/IndexDropService';
import type { ScanControl } from '../library/IndexDropService';
import { Tokens } from './tokens';

/**
 * Bind the two index-drop DAOs and the service over them.
 *
 * Both DAOs take the scope's **meter**, for the reason every other binding in this root does:
 * a DAO without one still works — its writes are simply issued whole and nothing counts them —
 * which is exactly why the wiring is asserted in `test/subrequest-budget.test.ts` rather than
 * trusted. An unmetered DAO is a path that spends nothing because nothing was watching it.
 *
 * The two port members are one-line delegations rather than direct DAO references because the
 * service's ports are its own interface. Handing it the DAOs would couple the service to
 * `backend-data`'s class shape, and the four methods it actually uses are a narrower and more
 * stable contract than either DAO is.
 */
function bindIndexDrop(scope: Container, db: D1Queryable, subrequests: SubrequestMeter, scanFor?: (libraryId: string) => ScanControl | null): void {
  const store = { stats: new IndexStatsDAO(db, subrequests), drop: new IndexDropDAO(db, subrequests) };
  scope.bindValue(Tokens.IndexStore, store);
  scope.bindValue(
    Tokens.IndexDropService,
    new IndexDropService(
      {
        statsForLibrary: async (libraryId) => await store.stats.statsForLibrary(libraryId),
        statsAcrossLibraries: async (libraryIds) => await store.stats.statsAcrossLibraries(libraryIds),
        dropLibrary: async (libraryId) => await store.drop.dropLibrary(libraryId),
        dropAll: async () => await store.drop.dropAll(),
      },
      scanFor,
    ),
  );
}

export { bindIndexDrop };
