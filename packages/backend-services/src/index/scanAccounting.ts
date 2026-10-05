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
 *
 * ### The third count, and why it is in the platform's unit
 *
 * `billedRows` is what the day's allowance is spent in, and it is a **third** question rather than
 * a refinement of either: what did the work cost the platform, as opposed to how much of it there
 * was or whether a cache went stale.
 *
 * D1 charges a write as the row *plus every index entry it rewrote* — pricing page, definition 6:
 * *"there are two rows written: one to the table itself, and one to the index."* So the unit is
 * not a row, and the multiplier is a property of the **table**: four for `nodes`, ten for `songs`,
 * two for `scan_state`, which carries no declared index at all. `backend-data`'s `billedRows.ts`
 * owns the per-table arithmetic and asserts it against the real schema.
 *
 * The import shares this allowance rather than having one of its own, which is why the multiplier
 * is a table lookup and not a constant in the scan: `import_runs` bills four, so a write the scan
 * would charge two for costs twice as much when the import makes it.
 *
 * This correction is why the two counts above were not enough. Every writer that reported only
 * `rowsWritten` forced its caller to guess, and the one place that guessed was the daily budget:
 * `applyMetadata` returned `void`, so `EnrichmentService` declared `1` for every enrichment,
 * while the statement billed ten. The guard was short by a factor of ten on the enrichment path —
 * a quarter of a cold scan's writes — for as long as it existed. Three questions, and the module
 * that can answer all three is the one the arithmetic is accumulated in.
 */

/**
 * What reconciling one folder cost.
 *
 * Returned rather than accumulated by the caller, because the caller is `step` and its three
 * consumers are the three guards above: `billedRows` goes to `ScanPauseStore`'s day budget,
 * `rowsWritten` is what the chunk reports, and `indexChanged` goes to `scan_state.changed` for
 * `complete` to read.
 */
interface FolderWrites {
  /**
  Table rows written, of every kind. Progress — and the input to `indexChanged`.
  */
  readonly rowsWritten: number;
  /**
  What those writes cost the platform. Not derivable from `rowsWritten` — see the header — and
  accumulated from each writer's own measurement rather than multiplied here: this module knows how
  to add two folders together, and `billedRows.ts` knows what a write costs.
  */
  readonly billedRows: number;
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
    billedRows: into.billedRows + folder.billedRows,
    indexChanged: into.indexChanged || folder.indexChanged,
  };
}

/**
 * A chunk that has written nothing yet.
 *
 * Named rather than inlined as a literal at three sites, so "nothing happened" is one value: an
 * accumulator that starts as an object literal is a place where a fourth field would be added to
 * the type and not to the initialiser — which is exactly how `billedRows` reached `FolderWrites`
 * with nothing summing it.
 */
const NO_FOLDER_WRITES: FolderWrites = { rowsWritten: 0, billedRows: 0, indexChanged: false };

export { mergeFolderWrites, NO_FOLDER_WRITES };
export type { FolderWrites };