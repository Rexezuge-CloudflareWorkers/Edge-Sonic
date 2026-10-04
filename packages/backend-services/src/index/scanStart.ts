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
import type { ScanBudget } from './scanBudget';
import type { ChunkResult, ScanDeps } from './scanTypes';

/**
 * `startScan`: probe the root and decide whether there is anything to do.
 *
 * Deliberately does no further walking. Making `startScan` the expensive request means a
 * client that calls it and then times out has learned nothing about progress.
 *
 * A free function over `ScanDeps` and a budget, like `scanPrelude`'s — this file was over the
 * god-file limit once the budget's own accounting was added to it, and `start` is the one
 * method that is not part of the chunk loop, so it is the one that reads as a separate concern.
 */
async function start(
  deps: ScanDeps,
  library: LibraryRow,
  budget: ScanBudget,
  fail: (library: LibraryRow, state: ScanStateRow, error: unknown, budget: ScanBudget) => Promise<ChunkResult>,
): Promise<ChunkResult> {
  const state = await deps.scanState.ensure(library.id);

  let root: DavResource | undefined;
  try {
    const listed = await (await deps.clientFor(library, () => budget.charge())).propfind('', { depth: 0, timeoutMs: deps.timeoutMs });
    root = listed.find((resource) => toLibraryPath(resource.path, library.root_path) === '') ?? listed[0];
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 410) {
      // The library root is gone. Clear the index rather than leaving rows that
      // point at paths which no longer exist.
      await deps.nodes.deleteSubtree(library.id, '');
      const indexVersion = await deps.scanState.complete(library.id, 0);
      return {
        status: 'idle',
        scanned: 0,
        total: 0,
        indexVersion,
        lastError: null,
        foldersVisited: 0,
        subrequests: budget.spend(),
        rowsWritten: 0,
        stoppedBy: null,
      };
    }
    return await fail(library, state, error, budget);
  }

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
      total: state.scanned_count,
      indexVersion: state.index_version,
      lastError: null,
      foldersVisited: 0,
      subrequests: budget.spend(),
      rowsWritten: 0,
      stoppedBy: null,
    };
  }

  // Seed the frontier with the root. Every other folder joins it as its parent is
  // reconciled, which is what bounds a chunk's subrequest count.
  await deps.nodes.upsertMany([
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
    total: 0,
    indexVersion: state.index_version,
    lastError: null,
    foldersVisited: 0,
    subrequests: budget.spend(),
    rowsWritten: 0,
    stoppedBy: null,
  };
}

export { start };
