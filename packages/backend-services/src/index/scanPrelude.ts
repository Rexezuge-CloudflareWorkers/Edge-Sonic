/**
 * What a chunk decides **before** it walks a single folder.
 *
 * Split out of `ScanService.step` so the guard can open at the top of that method's body.
 * That placement is the fix rather than a detail: five awaited calls — `ensure`, the
 * backfill, `listFrontier`, `fail`, `complete` — used to sit *outside* the `try`, so a D1
 * error in any of them rejected `step()` in production's only caller, `ScanWorker.alarm`.
 * That handler had no `try` of its own, so the alarm was consumed, the re-arm never ran,
 * and D1 still recorded `scanning` — which `getStatus` reports as *keep polling* while
 * nothing was scheduled to answer. Nothing reconciled the two stores: the alarm lives in
 * DO storage, the status in D1, and `getAlarm()` is called from nowhere.
 *
 * So these are free functions over `ScanDeps` rather than methods, and they take what they
 * need rather than reading `this`. The state machine they implement already lived in
 * `scanRetry.ts`; what was missing was the part between "decide whether to run" and "walk a
 * folder", which is a third thing and had no name.
 */
import { derivePending, NO_DERIVATION } from './deriveBackfill';
import type { DerivationCost } from './deriveBackfill';
import { rotatePendingSongIds, NO_ROTATION } from './songIdBackfill';
import { decideStep, idleResult, stalledResult, unableToAdvance } from './scanRetry';
import type { ScanBudget } from './scanBudget';
import type { ChunkResult, ScanDeps } from './scanTypes';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';

/**
 * Repair the derived grouping on rows the walk will never revisit.
 *
 * ### Ahead of everything, and that placement is the whole fix
 *
 * It runs before the status check deliberately. A fully scanned library is `idle`, and
 * `idle` returns without touching the walk at all — so a backfill placed after the status
 * check never runs for exactly the libraries that need it, which is what the first attempt
 * at this did.
 *
 * It runs here at all because nothing else can reach these rows. Every writer of
 * `album`/`artist` is gated on the file having *changed*, and that gating is correct: it is
 * what makes a rescan of an unchanged library cost one subrequest. The consequence is that
 * a library nobody has touched since it was indexed never derives its grouping and the
 * aggregates answer `[]` for ever. It shipped: 113 rows, every one indexed before the
 * deploy, every one with `album_ci` NULL.
 *
 * It reads `dir_path` off the row, so it spends no **WebDAV** subrequests — one indexed read
 * and one bounded write batch. It is charged against the subrequest ceiling like everything
 * else, though, because a D1 statement is a subrequest: the claim that this phase "cannot
 * spend" the ceiling is what let a 200-row batch run unbudgeted at the top of every poll —
 * and then, once the ceiling was charged, made that same batch **unwritable**, because the
 * write refuses rather than truncating and 200 statements fit in no chunk. The page is
 * `SCAN_DERIVE_MAX_ROWS_PER_CHUNK` and the check is `derivePending`'s; see it. Once a
 * library is current the read returns no rows and the batch is never issued, so a
 * poll on a healthy library still spends two statements. It never stamps `enriched_at`,
 * because `EnrichmentService` short-circuits on that: claiming a row was read would leave a
 * track with `duration: 0` never re-read on first play — a backfill that repairs the grouping
 * by breaking enrichment.
 */
async function backfill(deps: ScanDeps, libraryId: string, budget: ScanBudget): Promise<DerivationCost> {
  // Rotation first: a renamed row keeps its grouping, so order between the two
  // does not matter for correctness — but rotation is the one-time repair and
  // derivation the ongoing one, so the finite pass goes first.
  const rotated = deps.idRotation ? await rotatePendingSongIds(deps.idRotation, libraryId, budget) : NO_ROTATION;
  const derived = deps.derivation ? await derivePending(deps.derivation, libraryId, budget) : NO_DERIVATION;
  return { rowsWritten: rotated.rowsWritten + derived.rowsWritten, billedRows: rotated.billedRows + derived.billedRows };
}

/**
 * The `idle` result for a library whose frontier is empty.
 *
 * Completing bumps `index_version`, so this is the one place in the walk that invalidates
 * a whole generation of cached answers at once — which is why it is reached only from an
 * empty frontier, and never speculatively.
 */
async function finished(deps: ScanDeps, library: LibraryRow, state: ScanStateRow, derived: DerivationCost): Promise<ChunkResult> {
  const indexVersion = await deps.scanState.complete(library.id, state.scanned_count);
  return {
    status: 'idle',
    scanned: state.scanned_count,
    indexVersion,
    lastError: null,
    foldersVisited: 0,
    subrequests: NO_SUBREQUESTS_SPENT,
    // The backfill's rows, not zero. This path is reached by a library that is already
    // fully walked, which is the *usual* case for a library being repaired, so reporting
    // `0` here would report the repair as no work at all.
    rowsWritten: derived.rowsWritten,
    // And its *cost*, for the same reason and one level on: this is the ordinary return for a
    // repaired library, so a billed count of zero here would tell the Durable Object the day
    // was free after the phase that spends it ran.
    billedRows: derived.billedRows,
    stoppedBy: null,
    resumeAt: null,
  };
}

/**
 * Every way a chunk can be answered without walking a folder, or `null` to walk.
 *
 * Whether a `failed` scan may run again is a state-machine decision, and it is not an
 * obvious one: `failed` used to be terminal, and treating it as terminal is what left a
 * library of eighty albums at one scanned folder for the life of a deployment. See
 * `scanRetry.ts` for the whole account.
 */
async function settle(
  deps: ScanDeps,
  library: LibraryRow,
  state: ScanStateRow,
  derived: DerivationCost,
  frontier: readonly { path: string }[],
): Promise<ChunkResult | null> {
  const decision = decideStep(state);
  if (decision === 'stalled') return stalledResult(state, derived);
  if (decision === 'idle') return idleResult(state, 'idle', derived);
  if (frontier.length > 0) return null;

  // An empty frontier normally means the scan is done, and `complete` is right.
  //
  // The exception is a chunk *entered from* a failed state, where there is nothing left to
  // retry — and completing would claim a library is fully walked when the walk stopped.
  // `start` seeds the frontier with the library root, so a scan that failed in its own
  // root probe is the case that lands here.
  if (state.status === 'failed') {
    return await unableToAdvance(state, async (error) => await deps.scanState.fail(library.id, error), derived);
  }
  return await finished(deps, library, state, derived);
}

export { backfill, finished, settle,  };
export {NO_DERIVATION} from './deriveBackfill';