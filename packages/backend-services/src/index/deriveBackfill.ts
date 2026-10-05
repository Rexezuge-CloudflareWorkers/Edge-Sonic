/**
 * The bounded pass that backfills the path-derived grouping.
 *
 * ### Why this runs on every poll, ahead of the scan
 *
 * Because the scan is not what needs it. Every writer of the grouping is gated on a file
 * having *changed* — the `Depth: 0` root probe, `isScanned: !changed`, `if (changed)` in
 * `reconcileFolder`, and the read-through `getMusicDirectory` path. That gating is
 * correct and is the entire point of storing `mtime_ms` in `nodes`; what it means is that
 * a library nobody has touched since it was indexed **never** derives its grouping, and
 * `getArtists`/`getAlbumList2`/`getGenres`/`search3` answer `[]` for ever.
 *
 * So it runs before `decideStep`, which is the part that matters: a library sitting at
 * `idle` — which is exactly the state a fully-scanned library is in, and the state the
 * deployed instance was in — returns from `step` without touching the walk at all. A
 * backfill placed after the status check would therefore never run for precisely the
 * libraries that need it.
 *
 * ### Why it costs no subrequests
 *
 * `dir_path` is already on the row, so this is a function of data D1 already holds: one
 * indexed read and one bounded write batch, no `PROPFIND`, no range read. It is charged
 * against the chunk's wall-clock deadline *and* against the subrequest ceiling, because the
 * claim that this phase "cannot spend" the ceiling is what let a 200-row batch run unbudgeted
 * at the top of every poll.
 *
 * ### Why it is bounded per chunk rather than run to completion
 *
 * Because a poll is a request a client is waiting on, and a 5,000-row library backfilled
 * in one poll is a poll that times out — which is the `getScanStatus` defect that made a
 * chunk take 88 s against a client's 45 s patience, repeated on a different axis. Each
 * chunk takes one page; the next poll takes the next. The selection is on
 * `derived_version`, so the remaining set strictly shrinks and the pass terminates
 * without any cursor to keep.
 *
 * ### A page a chunk cannot write whole is a permanent failure, not a slow one
 *
 * `applyDerivation` passes `requireComplete`, so it **refuses** rather than truncating, and
 * the refusal is correct — the selection is on `derived_version`, so a partial page leaves
 * rows stamped and rows not stamped, and the un-stamped ones are re-selected for ever.
 *
 * Which makes the page size a bound the chunk budget *imposes*. It was
 * `DERIVE_MAX_ROWS_PER_CHUNK = 200` — one `UPDATE` per row — against a chunk budget of 42
 * and a platform ceiling of 50, so it fitted on no chunk under any configuration. Every
 * library with more than ~48 rows owing a derivation therefore threw
 * `SubrequestBudgetExhaustedError` out of here, on every poll, **before `listFrontier`**:
 * the walk never ran, `scanned_count` never advanced, `step`'s catch recorded it as a scan
 * failure, and `isAdvancing('failed')` kept the alarm re-armed — so `getScanStatus` reported
 * `scanning: true` for ever. Shipped alongside the subrequest metering that made the refusal
 * reachable, and together with the index write's failure to stamp `derived_version`, which is
 * what kept every scanned row permanently owed. Both are needed to produce the wedge and
 * neither produces it alone; `songSql.ts` carries the other half.
 *
 * So the page is `SCAN_DERIVE_MAX_ROWS_PER_CHUNK`, derived from the chunk budget with
 * `SUBSREQUESTS_PER_FOLDER_BASE` held back — a chunk that spends its whole backfill
 * allowance must still visit one folder. The `canAfford` below is the other half of that
 * guarantee: the derived size bounds a chunk that has spent nothing, and the only thing that
 * decides whether *this* chunk can take it is what it has already spent.
 */
import { SongDerivationDAO } from '@edge-sonic/backend-data/dao';
import { SCAN_DERIVE_MAX_ROWS_PER_CHUNK } from '@edge-sonic/backend-runtime/config';
import type { ScanDerivationStore } from './scanTypes';
import type { ScanBudget } from './scanBudget';

/**
 * Stamp one page of rows, and report how many rows it wrote.
 *
 * `0` for a library that is already current, which is the value that makes this free in
 * the steady state: one indexed read that returns no rows, and no statement issued.
 */
async function derivePending(store: ScanDerivationStore, libraryId: string, budget: ScanBudget): Promise<number> {
  // Checked before the read, not after: a chunk whose deadline has already passed should
  // not start a write batch it may not finish. The rows stay behind and the next poll
  // takes them, which is the same "leave, don't overrun" rule the walk follows.
  if (budget.remainingMs <= 0) return 0;

  const rows = await store.listNeedingDerivation(libraryId, SCAN_DERIVE_MAX_ROWS_PER_CHUNK);
  if (rows.length === 0) return 0;

  // The read is spent; the write is one statement per row and it refuses rather than
  // truncating, so a page this chunk cannot hold whole is a page this chunk may not take.
  // Checked *after* the read because the read is what tells us the page's size — the same
  // "decide before the work, on its whole cost" discipline the walk applies to
  // `canAfford(SUBSREQUESTS_PER_FOLDER_BASE)`, and for the same reason: a reservation made
  // after the statements are issued is not a reservation.
  //
  // Returning `0` rather than throwing is the difference between a slow repair and a dead
  // scan. The selection is on `derived_version`, so the rows are exactly the next poll's,
  // and the walk below — which shares this budget — is not starved by a phase that could not
  // have written them anyway.
  if (!budget.canAfford(rows.length)) return 0;

  // `deriveFor` rather than a `map` at the call site: reading a page and deciding on that
  // same page is one step, and a caller that did half of it would stamp rows it never
  // derived anything for — which is how a backfill that re-selects its own work for ever
  // is built.
  return await store.applyDerivation(SongDerivationDAO.deriveFor(rows));
}

export { derivePending };
