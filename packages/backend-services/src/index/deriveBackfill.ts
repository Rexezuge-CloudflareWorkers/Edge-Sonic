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
 * against the chunk's wall-clock deadline because D1 latency is real, and against
 * nothing else — the subrequest ceiling is a platform resource this phase cannot spend.
 *
 * ### Why it is bounded per chunk rather than run to completion
 *
 * Because a poll is a request a client is waiting on, and a 5,000-row library backfilled
 * in one poll is a poll that times out — which is the `getScanStatus` defect that made a
 * chunk take 88 s against a client's 45 s patience, repeated on a different axis. Each
 * chunk takes one page; the next poll takes the next. The selection is on
 * `derived_version`, so the remaining set strictly shrinks and the pass terminates
 * without any cursor to keep.
 */
import { SongDerivationDAO } from '@edge-sonic/backend-data/dao';
import type { ScanDerivationStore } from './scanTypes';
import type { ScanBudget } from './scanBudget';

/**
 * Rows stamped per chunk.
 *
 * Sized against D1's **row-write** allowance, not the subrequest ceiling, because those
 * are the two resources this phase actually spends. A 1,000-track library drains in five
 * polls, which is a few seconds of a client that is already polling to drive a scan.
 *
 * Not a parameter: there is no configuration in which a different number is correct, and
 * a knob here would be a knob nobody turns.
 */
const DERIVE_MAX_ROWS_PER_CHUNK = 200;

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

  const rows = await store.listNeedingDerivation(libraryId, DERIVE_MAX_ROWS_PER_CHUNK);
  if (rows.length === 0) return 0;

  // `deriveFor` rather than a `map` at the call site: reading a page and deciding on that
  // same page is one step, and a caller that did half of it would stamp rows it never
  // derived anything for — which is how a backfill that re-selects its own work for ever
  // is built.
  return await store.applyDerivation(SongDerivationDAO.deriveFor(rows));
}

export { DERIVE_MAX_ROWS_PER_CHUNK, derivePending };
