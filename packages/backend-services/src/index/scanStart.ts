/**
 * Seeding a scan: the `Depth: 0` root probe, and whether there is anything to walk.
 *
 * Split out of `ScanService` for the same reason `scanPrelude.ts` is: this is not the chunk
 * loop, it is the one request that decides whether the loop runs at all, and it was the method
 * that pushed the file over the god-file limit once the budget's own accounting landed in it.
 *
 * ### The cheap path, and the floor under it
 *
 * A matching root mtime against a completed scan is what makes a rescan cost **one**
 * subrequest and write zero rows — the whole incrementality design. It was also a claim that
 * nothing below the root had been read, which `nodes.mtime_ms` cannot make: that column has
 * two writers, the scan and `TreeService`'s read-through browse, and they mean opposite things.
 * So the short-circuit also requires the library to have tracks — one indexed read, on
 * `startScan` only — which is what makes the cheap path safe to be wrong about: an empty result
 * re-walks rather than reporting a library it has no evidence is current.
 *
 * See `scanFolder.ts` for the matching fix on the descent side, and
 * `docs/issues/free-plan-subrequest-ceiling.md` for why this file's budget is a *total*.
 */
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource } from '@edge-sonic/webdav';
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import { nextMidnightUtc } from '@edge-sonic/backend-data/utils';
import { dailyWriteAllowanceSpent, d1AllowancePause, pausedResult } from './scanRetry';

/**
 * What one `scan_state` write costs against the day's allowance, in billed rows.
 *
 * One, plus the single index SQLite creates for `library_id TEXT PRIMARY KEY` — and `scan_state`
 * is the one table in this schema with **no declared index at all**, which is exactly why the
 * number is 2 rather than the 10 a `songs` write costs.
 *
 * Named rather than written as a literal at the call site because `markScanning` returns `void`
 * and there is nothing to measure it from — and a hand-written `1` there is the same
 * claim-about-work pattern `BaseDAO.runWriteStatement` exists to remove. `test/schema.int.test.ts`
 * asserts every table's factor against the real schema, so a migration adding an index to
 * `scan_state` turns that suite red rather than quietly making this wrong.
 */
const BILLED_SCAN_STATE_WRITE = 2;
import type { ScanBudget } from './scanBudget';
import type { ChunkResult, ScanDailyBudget, ScanDeps } from './scanTypes';

/**
 * `startScan`: probe the root and decide whether there is anything to do.
 *
 * Deliberately does no further walking. Making `startScan` the expensive request means a
 * client that calls it and then times out has learned nothing about progress.
 *
 * A free function over `ScanDeps` and a budget, like `scanPrelude`'s — this file was over the
 * god-file limit once the budget's own accounting was added to it, and `start` is the one
 * method that is not part of the chunk loop, so it is the one that reads as a separate concern.
 *
 * ### Two refusals it has to survive, and neither is a scan fault
 *
 * `start` writes. It seeds the frontier's root row and resets the progress counters, and it is
 * the operator's Rescan button as much as a client's `startScan`. So while D1 is refusing
 * queries for a spent daily allowance, it fails — on the `ensure` above, on the `find`, on the
 * seeding write, each of which is outside the `try` that classifies the `PROPFIND`.
 *
 * Both are answered with `paused` rather than propagated as a fault, and neither spends the
 * retry budget. An operator pressing Rescan during a pause gets the pause and the time it ends,
 * which is the truth; the alternative was a masked 500 on the one surface whose job is to explain
 * what is wrong.
 */
async function start(
  deps: ScanDeps,
  library: LibraryRow,
  budget: ScanBudget,
  dailyBudget: (() => ScanDailyBudget) | undefined,
  fail: (library: LibraryRow, state: ScanStateRow, error: unknown, budget: ScanBudget) => Promise<ChunkResult>,
): Promise<ChunkResult> {
  let state: ScanStateRow;
  try {
    state = await deps.scanState.ensure(library.id);
  } catch (error) {
    // The one place D1 is refusing everything, including the read that would have produced the
    // row. Answering `failed` here would spend a statement on a write that cannot succeed and
    // arm the alarm a second later, which is the loop `paused` exists to stop.
    const pause = d1AllowancePause(error, deps.now?.() ?? Date.now());
    if (pause) return pause;
    throw error;
  }

  // A scan that has spent its share does not re-seed the frontier: seeding writes a row, and the
  // whole point of having spent the share is to stop writing.
  const daily = dailyBudget?.();
  if (daily && dailyWriteAllowanceSpent(daily)) {
    return pausedResult(
      nextMidnightUtc(daily.now()),
      `This library has written its ${daily.limit}-row share of today's D1 row-write allowance. The scan resumes itself at 00:00 UTC.`,
      state.scanned_count,
    );
  }

  let root: DavResource | undefined;
  try {
    const listed = await (await deps.clientFor(library, () => budget.charge())).propfind('', { depth: 0, timeoutMs: deps.timeoutMs });
    root = listed.find((resource) => toLibraryPath(resource.path, library.root_path) === '') ?? listed[0];
  } catch (error) {
    // Ahead of the `404` branch on purpose, and for the same reason: a refusal to answer is not
    // a root that has gone away, and reading it as one would `deleteSubtree` the entire index on
    // a fault that has nothing to do with the library's contents.
    const pause = d1AllowancePause(error, deps.now?.() ?? Date.now());
    if (pause) return pause;
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 410) {
      // The library root is gone. Clear the index rather than leaving rows that
      // point at paths which no longer exist.
      // `true`, and this is the one caller that has to insist: it just deleted the whole
      // index outside a scan, so nothing carried `changed = 1` and the version bump that
      // makes the deleted rows unreachable would be skipped.
      const cleared = await deps.nodes.deleteSubtree(library.id, '');
      const indexVersion = await deps.scanState.complete(library.id, 0, true);
      return {
        status: 'idle',
        scanned: 0,
        indexVersion,
        lastError: null,
        foldersVisited: 0,
        subrequests: budget.spend(),
        // A whole-library delete is one of the largest writes in the product, so reporting
        // `0` here would have told the Durable Object's day-budget that nothing was spent — and
        // this runs on a `startScan`, which runs on every client login.
        rowsWritten: cleared.changes,
        billedRows: cleared.billedRows,
        stoppedBy: null,
        resumeAt: null,
      };
    }
    return await fail(library, state, error, budget);
  }

  // Everything from here writes, so it is inside the same classification as the probe. Split out
  // as a helper rather than a `try` around eighty lines of comments, because a `try` this wide
  // would also swallow a genuine bug in the arithmetic below and answer `paused` for it — and
  // `d1AllowancePause` returns `null` for anything that is not D1's refusal, so the outer `catch`
  // rethrows. That is the property that makes the wide `try` safe, and it is why the classifier
  // returns `null` rather than a boolean.
  try {
    return await seed(deps, library, budget, state, root);
  } catch (error) {
    const pause = d1AllowancePause(error, deps.now?.() ?? Date.now());
    if (pause) return pause;
    throw error;
  }
}

/**
 * The rest of `start`: compare the root against what is stored, and seed the frontier.
 *
 * Split from `start` purely so the classification above wraps a named function instead of a
 * hundred lines — the decision "is this the platform refusing us or is this a bug" must not be
 * made by the width of a `try` block.
 */
async function seed(deps: ScanDeps, library: LibraryRow, budget: ScanBudget, state: ScanStateRow, root: DavResource | undefined): Promise<ChunkResult> {
  const rootMtime = root?.lastModifiedMs ?? null;
  const stored = await deps.nodes.find(library.id, '');

  // A completed scan whose root mtime still matches means nothing below it
  // moved. This comparison against the *stored* value is the entire reason a
  // rescan is free.
  //
  // ### The floor, and why "completed" is not enough on its own
  //
  // The stored mtime is written by two callers — the scan and `TreeService`'s
  // read-through browse — so a match says *something* listed this root, not that
  // anything below it was ever read. Worse, a scan that indexed nothing is
  // indistinguishable here from a scan that finished: `scanned_count` counts
  // folders *visited*, and a walk that visited the root and closed every child
  // unread has `scanned_count = 1`.
  //
  // That combination is what made a broken library permanent rather than merely
  // wrong. Once `complete()` recorded `idle` with a matching root mtime, this
  // branch fired on every later `startScan` and the library could never be
  // re-walked — the only escapes were the origin's root mtime moving or the
  // library being deleted, which cascades the whole index away.
  //
  // So the short-circuit also requires that the library has tracks. One indexed
  // read on `startScan` only — not on any chunk — and it is what makes the cheap
  // path *safe to be wrong about*: an empty result re-walks rather than reporting
  // a library it has no evidence is current.
  const indexedTracks = state.status === 'idle' && state.scanned_count > 0 ? await deps.songs.countByLibrary(library.id) : 0;

  if (state.status === 'idle' && state.scanned_count > 0 && indexedTracks > 0 && rootMtime !== null && stored?.mtime_ms === rootMtime) {
    return {
      status: 'idle',
      scanned: state.scanned_count,
      indexVersion: state.index_version,
      lastError: null,
      foldersVisited: 0,
      subrequests: budget.spend(),
      rowsWritten: 0,
      // A measured zero: this branch issued one `PROPFIND` and no statement, so it spent
      // nothing on either unit. Distinct from the branch above, which issued a delete.
      billedRows: 0,
      stoppedBy: null,
      resumeAt: null,
    };
  }

  // Seed the frontier with the root. Every other folder joins it as its parent is
  // reconciled, which is what bounds a chunk's subrequest count.
  const seeded = await deps.nodes.upsertMany([
    {
      libraryId: library.id,
      path: '',
      parentPath: '',
      name: '',
      mtimeMs: rootMtime,
      etag: root?.etag ?? null,
      depth: 0,
      isScanned: false,
    },
  ]);

  await deps.scanState.markScanning(library.id, 0);
  return {
    status: 'scanning',
    scanned: 0,
    indexVersion: state.index_version,
    lastError: null,
    foldersVisited: 0,
    subrequests: budget.spend(),
    // Two writes, both real: the frontier row this just seeded and the `scan_state` row
    // `markScanning` flipped. `startScan` runs on every client login, so a start that reports
    // nothing spent is a start the day's allowance cannot see — and this is the path a
    // **repeat** start takes, where the root mtime has moved, so it is not a once-per-library
    // cost at all.
    rowsWritten: seeded.changes + 1,
    billedRows: seeded.billedRows + BILLED_SCAN_STATE_WRITE,
    stoppedBy: null,
    resumeAt: null,
  };
}

export { start };
