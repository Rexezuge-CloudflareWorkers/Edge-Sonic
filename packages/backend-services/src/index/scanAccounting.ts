/**
 * What one unit of scan work cost, as **two** questions rather than one number.
 *
 * ### Why this is its own module
 *
 * Because it is a decision, and the two answers are used by two different guards that fail in
 * opposite directions. `scanTypes.ts` was already over the god-file limit when these were added
 * to it, and `ScanService` and `EnrichmentService` are both over it now for the same reason:
 * a statement about what a number *means* is much longer than the number, and it belongs
 * somewhere it can be read without opening a state machine to find it.
 *
 * ### The pair
 *
 * `rowsWritten` is the day's **row-write allowance**, where every row counts — including the
 * folder's own `is_scanned` flip, which is a real D1 row against the same allowance.
 *
 * `indexChanged` is whether anything a **cached aggregate** reads moved, and the folder's own
 * row is exactly where the two answers part company. That row carries `is_scanned` and a
 * re-observation of a folder whose children were just compared, one at a time, against the very
 * rows this call left alone. It changes no name, no path, no song and no grouping, so a cache
 * invalidated by it is a false answer.
 *
 * And that is not a theoretical difference, because the re-observation is not stable on every
 * origin. Measured on a live WebDAV server: the library root's `getlastmodified` answers the
 * **request's** clock — `Mon, 05 Oct 2026 04:23:47 GMT` for the root while its 83 children in
 * the same response carried `Sat, 26 Sep 2026`, and three bursts of probes returned 04:23:47,
 * then 04:24:39, then 04:28:13. So the root's row differs on every pass, and since `start`'s
 * cheap path compares that same column it can never short-circuit.
 *
 * ### Why deriving one from the other is wrong in both directions
 *
 * From the count, the signal becomes a function of **how many times the library was rescanned**
 * rather than of whether it changed — and `startScan` runs on every Subsonic client login and on
 * the operator's Rescan. Each one would make every cached album, artist, genre and search in the
 * deployment unreachable, against a free plan's 1,000 KV writes a day.
 *
 * From the signal, the allowance is under-reported by exactly the bookkeeping rows, so the guard
 * that exists to stop the scan spending the day's allowance stops bounding it.
 *
 * Neither is a refinement of the other. They are two questions, and `scan_folder` is the only
 * place that can answer both.
 */

/**
 * What reconciling one folder cost.
 *
 * Returned rather than accumulated by the caller, because the caller is `step` and its two
 * consumers are the two guards above: `rowsWritten` goes to `ScanPauseStore`, and
 * `indexChanged` goes to `scan_state.changed` for `complete` to read.
 */
interface FolderWrites {
  /**
  Rows written, of every kind. The day's row-write allowance counts all of them.
  */
  readonly rowsWritten: number;
  /**
  Whether anything a cached aggregate reads moved. Frontier bookkeeping does not count.
  */
  readonly indexChanged: boolean;
}

/**
 * The one way to combine a folder's answer with the chunk's.
 *
 * A function rather than `+` and `||` at the call site, because the two halves are additive and
 * monotonic by construction and spelling that out at each use is how a later writer forgets one
 * of them. `ScanService.step` is the only caller today.
 */
function mergeFolderWrites(into: FolderWrites, folder: FolderWrites): FolderWrites {
  return {
    rowsWritten: into.rowsWritten + folder.rowsWritten,
    indexChanged: into.indexChanged || folder.indexChanged,
  };
}

/**
 * A chunk that has written nothing yet.
 *
 * Named rather than inlined as `{ rowsWritten: 0, indexChanged: false }` at three sites, so
 * "nothing happened" is one value: an accumulator that starts as an object literal is a place
 * where a fourth field would be added to the type and not to the initialiser.
 */
const NO_FOLDER_WRITES: FolderWrites = { rowsWritten: 0, indexChanged: false };

export { mergeFolderWrites, NO_FOLDER_WRITES };
export type { FolderWrites };