/**
 * Reconciling one folder's listing.
 *
 * Split out of `ScanService` because it is a different concern from the chunk that
 * drives it: `ScanService` decides *how much* walk a chunk does, and this decides what
 * happens to the folder it decided to open. The same split `scanEnrichment.ts` makes
 * for the same reason.
 *
 * It is also a size split. The walk and its budget arrived together, and folding
 * `reconcileFolder` back into the service puts the file over the god-file limit — so
 * the boundary is drawn here rather than chosen.
 */
import type { LibraryRow, NodeRow } from '@edge-sonic/backend-data/dao';
import { encodeId, IdKind } from '@edge-sonic/subsonic';
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource } from '@edge-sonic/webdav';
import { basename, isAudioFile, suffixOf } from './libraryNames';
import { enrichChanged } from './scanEnrichment';
import { nodeRowNeedsWrite } from './nodeWrite';
import type { ScanBudget } from './scanBudget';
import type { FolderWrites } from './scanAccounting';
import type { ScanDeps, ScanNodeInput, ScanSongInput } from './scanTypes';

/**
 * Reconcile one folder's listing: write what changed, prune what vanished.
 *
 * Two decisions per child, and they are **not the same question**:
 *
 * - **Does this node row need rewriting?** `nodeRowNeedsWrite`, against the child's
 *   stored row. `upsertFileFacts` deliberately leaves derived metadata alone, so a
 *   redundant write would spend a row to rewrite values that are already correct.
 * - **Does this folder need descending into?** Answered by `is_scanned` *as well
 *   as* by the mtime — see `needsDescent` below, which is where this file's one
 *   real defect lived.
 *
 * The second is what makes a one-album change cost one request instead of one per
 * folder, so it has to be right rather than merely cheap.
 *
 * ### The first is what makes a folder that fits in one invocation finish
 *
 * It was described here and not implemented, and the omission was a scan that could not
 * complete. Without the compare, `nodeInputs` is every child of the folder, changed or not,
 * so `runWriteBatch` truncates it against the invocation's ceiling — and the rows it had
 * already written are the rows it re-offers first, so the truncation lands at the same offset
 * every time. `truncated` is therefore permanently true on a folder with more entries than fit,
 * the folder's own `is_scanned: true` is never written, the folder never leaves the frontier,
 * and each chunk rewrites the same ~45 rows against a 5,000-rows/day allowance. 231,620 rows
 * on an 80-album library of 110 tracks, and a scan that reported `scanning` for ever.
 *
 * With it, the second pass offers only what is still missing, the batch stops being
 * truncated, and the folder closes: 49 rows, then 31, then nothing. `test/scan-convergence.test.ts`
 * asserts that arithmetic, because a comment about it is what the code carried instead.
 */
async function reconcileFolder(
  deps: ScanDeps,
  library: LibraryRow,
  folder: NodeRow,
  resources: readonly DavResource[],
  budget: ScanBudget,
): Promise<FolderWrites> {
  // The folder's own entry in this listing, kept for the `is_scanned` write further down —
  // where the comment on why it must be the *fresh* mtime lives, beside the write.
  const self = resources.find((resource) => toLibraryPath(resource.path, library.root_path) === folder.path);

  // One query for the folder's existing children; every comparison below is then
  // in-memory. A `find` per child is 2N round trips for a 500-track album.
  const existing = new Map((await deps.nodes.listChildren(library.id, folder.path)).map((node) => [node.path, node]));

  const nodeInputs: ScanNodeInput[] = [];
  const songInputs: ScanSongInput[] = [];
  const childPaths: string[] = [];
  const songPaths: string[] = [];

  for (const resource of resources) {
    const path = toLibraryPath(resource.path, library.root_path);
    if (path === null || path === folder.path) continue;
    childPaths.push(path);

    const name = basename(path);
    const known = existing.get(path);
    const mtimeMoved = !known || known.mtime_ms !== resource.lastModifiedMs;
    const etagMoved = known !== undefined && resource.etag !== null && known.etag !== null && known.etag !== resource.etag;
    const changed = mtimeMoved || etagMoved;

    // ### `is_scanned` has two writers and one key
    //
    // `nodes` is written by the scan *and* by `TreeService`'s read-through browse, which
    // materialises a folder listing on a client's first visit. Both write `mtime_ms`
    // from the same `Depth: 1` PROPFIND, so **a matching mtime cannot say which of them
    // wrote it** — and the two mean opposite things. The scan wrote it *after descending
    // into that folder*; the browse wrote it having read nothing at all below it.
    //
    // Reading `!changed` as "already reconciled" therefore closed folders the scan had
    // never opened. It shipped: 80 album folders, all `is_scanned = 1`, none of them ever
    // listed, `songs` empty, `scan_state` `idle` — and "Up to date. 0 tracks indexed",
    // because `settle` found an empty frontier and called it finished.
    //
    // So `is_scanned` is an **input** to this decision and not only its output, and it is
    // the only one of the two that says "someone actually descended". A folder the *browse*
    // materialized is written `is_scanned = 0`, so `0` and "absent" both mean *not reconciled*
    // and both descend.
    //
    // This is the `reader_version` invariant one level up: a row's meaning is a function
    // of the bytes *and* of what read them, and keying on only one makes the other
    // unreachable.
    const needsDescent = resource.isCollection && (known?.is_scanned !== 1 || mtimeMoved || etagMoved);

    const desired = {
      parentPath: folder.path,
      name,
      mtimeMs: resource.lastModifiedMs,
      etag: resource.etag,
      depth: path.split('/').length,
      // A new or moved folder must be opened; an unreconciled one must be too.
      isScanned: !needsDescent,
    };

    // Only the rows whose stored state differs. The etag rule here and the one in
    // `TreeService` are now one function, because they were two and they disagreed: the
    // browse's comparison ignored a row whose etag went from a value to none, which froze
    // the subtree that only an etag had changed.
    if (nodeRowNeedsWrite(known, desired)) {
      nodeInputs.push({ libraryId: library.id, path, ...desired });
    }

    // Non-audio files are still nodes — they show in a folder listing — but never
    // become songs, so they never reach an index or a search result.
    if (resource.isCollection || !isAudioFile(name)) continue;
    songPaths.push(path);
    if (changed) {
      songInputs.push({
        id: encodeId(IdKind.Song, library.id, path),
        libraryId: library.id,
        path,
        dirPath: folder.path,
        name,
        size: resource.contentLength ?? 0,
        mtimeMs: resource.lastModifiedMs ?? 0,
        contentType: resource.contentType,
        suffix: suffixOf(name),
      });
    }
  }

  // ### A listing that placed nothing is not a listing that found nothing
  //
  // Everything above `continue`s on `path === null`, which is `toLibraryPath` refusing a
  // path that is not under the library root. If that fires for *every* href, the root
  // path and the server's href shape disagree — RFC 4918 §8.3 lets a server anchor
  // `DAV:href` differently, and one configuration (`href_prefix_mode` on a bucket-per-
  // volume origin) answers `207` perfectly while placing none of it.
  //
  // Left alone, that empties `childPaths` and `songPaths`, so the prune below concludes
  // every existing child **vanished** and deletes the library — recursively, on both
  // planes — then reports `idle`. "We could not place these paths" and "the operator
  // deleted their music" were the same observation.
  //
  // So it throws, before a single row is written: the folder stays on the frontier, the
  // prune never runs, and `ScanService.step`'s catch records the reason against the
  // retry budget. Bounded to `MAX_CONSECUTIVE_FAILURES` failures, so a library nobody can
  // fix lands on `stalled` — whose label already names the remedy — rather than looping.
  //
  // Counted over the entries that are **not the folder's own**, because a `Depth: 1`
  // listing of an empty folder contains exactly one entry — itself — and that is a folder
  // with nothing in it, not a folder we failed to read. Without the exclusion this guard
  // fires on every empty leaf directory, which is most of them.
  const selfEntries = resources.filter((resource) => toLibraryPath(resource.path, library.root_path) === folder.path).length;
  const foreignEntries = resources.length - selfEntries;

  if (foreignEntries > 0 && childPaths.length === 0) {
    throw new Error(
      `The WebDAV server listed ${foreignEntries} entries under "${folder.path || '/'}" but none could be ` +
        'matched to the configured library root path, so nothing could be indexed and nothing was pruned. ' +
        'Check that the root path is the prefix the server puts in its DAV:href values.',
    );
  }

  let writes = 0;
  // The **index-changed** signal, kept apart from `writes` because they answer different
  // questions about the same rows. `writes` is the day's row-write allowance, where every
  // row counts; `indexChanged` is whether a cached answer is now stale, where a frontier
  // flag flipping does not count. Deriving one from the other is wrong in both directions —
  // see the own-row write below, and `scanTypes.FolderWrites`.
  let indexChanged = false;
  // The children go first, and the folder's own row — the one carrying `is_scanned: true`,
  // the flag that takes this folder off the frontier — goes **last, and only if every child
  // landed**.
  //
  // That ordering is the fix for the folder that is larger than the invocation's subrequest
  // budget. A 500-track album is ~1,000 statements against a ceiling of 50, so `upsertMany`
  // writes what fits and reports `truncated`; retiring the folder at that point would leave a
  // folder whose tracks were never indexed with nothing on the frontier to revisit it.
  // Leaving `is_scanned` alone keeps it there, and because both upserts are keyed on `path`
  // and skip rows whose mtime has not moved, the next chunk re-lists the folder, recognises the
  // rows it already wrote, and writes only the ones that are missing.
  const childNodes = await deps.nodes.upsertMany(nodeInputs);
  writes += childNodes.changes;
  indexChanged ||= childNodes.changes > 0;
  const songRows = songInputs.length > 0 ? await deps.songs.upsertFileFacts(songInputs) : { changes: 0, truncated: false };
  writes += songRows.changes;
  indexChanged ||= songRows.changes > 0;

  const truncated = childNodes.truncated || songRows.truncated;
  if (truncated) {
    // Enrichment and the prune both read from what was *written*, and both are wrong on a
    // partial write. Enriching spends five subrequests per track to produce metadata for rows
    // that are not there; the prune derives its `vanished` set from the rows D1 holds, so it
    // would delete exactly the children this listing reported and the upsert could not write —
    // the partial-write case deleting the complement of itself.
    //
    // So the folder returns here, unfinished, on the frontier. Nothing is lost: the next chunk
    // re-reads the same `Depth: 1` listing and finishes it.
    return { rowsWritten: writes, indexChanged };
  }

  // Counted into `writes` and deliberately **not** into `indexChanged`.
  //
  // This row is frontier bookkeeping plus a re-observation of a folder whose children were
  // just compared, one entry at a time, against the very rows this call is about to leave
  // alone. `is_scanned` is a scan cursor; `mtime_ms`/`etag` on this row are what the *parent*
  // reads to decide whether to descend here. Nothing a cached aggregate reads — a name, a
  // path, a song, a grouping — is touched by this write.
  //
  // So counting it would make `index_version` a function of how many times the library was
  // rescanned rather than of whether it changed, which is the defect: an origin that stamps a
  // collection's `getlastmodified` per request makes this row differ on every pass, and since
  // `start`'s cheap path compares that same column it can never short-circuit — so every
  // `startScan`, and `startScan` runs on every client login, would invalidate every cached
  // album, artist, genre and search in the deployment for a rescan that moved nothing.
  writes += (
    await deps.nodes.upsertMany([
      {
        libraryId: library.id,
        path: folder.path,
        parentPath: folder.parent_path,
        name: folder.name,
        // The folder's own entry, straight from this listing. Its mtime is the *fresh* one and
        // is what gets written back — writing the frontier row's stored value instead would
        // leave the index permanently one version behind, so the next `startScan` would see a
        // mismatch and re-walk the whole library every time.
        mtimeMs: self?.lastModifiedMs ?? folder.mtime_ms,
        etag: self?.etag ?? folder.etag,
        depth: folder.depth,
        isScanned: true,
      },
    ])
  ).changes;

  // Fill in what a range read knows and a `PROPFIND` does not: duration, bitrate, and
  // the text tags that `getArtists`, `getAlbumList2`, `getGenres` and `search3` all
  // group on. Without this, a browsing client sees `duration: 0` and no artist on
  // every track until it happens to open one — and the aggregates stay empty, because
  // there is nothing to group.
  //
  // Only the rows this listing changed, which is exactly the set whose `enriched_at`
  // the upsert just cleared. An unchanged track costs nothing.
  //
  // Counted, and this line is the whole of the fix. `enrichChanged` reports rows **written**
  // rather than tracks attempted, because `rowsWritten` is the only input to the day's
  // row-write budget: leaving this term out made roughly a quarter of a cold scan's D1
  // writes invisible to the guard that exists to stop the scan spending them, while
  // `BaseDAO.withRetry` charged every one of them to the subrequest meter. One counter blind
  // to a class of writer beside one that counted them all. See `scanEnrichment.ts`.
  const enriched = await enrichChanged(library, songInputs, deps.enrichSong, deps.enrichMaxPerFolder, budget);
  writes += enriched;
  // A duration or an album tag landing on a song *is* a change the aggregates read, and it is
  // the one writer here that is invisible to the two upserts above — which is why this is
  // counted separately from them and not folded into `songRows.changes`.
  indexChanged ||= enriched > 0;

  // Prune. Unconditional, and both calls return 0 without issuing a statement when
  // nothing vanished.
  //
  // The song prune must NOT be guarded on `songPaths.length > 0`: that guard skips
  // the prune exactly when a folder has lost *every* track, which is the case that
  // matters most — an album deleted on the WebDAV side would keep all of its rows
  // and go on appearing in `search3` forever.
  const keptPaths = new Set(childPaths);
  const vanished = (await deps.nodes.listChildren(library.id, folder.path))
    .map((node) => node.path)
    .filter((path) => path !== folder.path && !keptPaths.has(path));

  const prunedSongs = (await deps.songs.deleteInDirectoryNotIn(library.id, folder.path, songPaths)).changes;
  writes += prunedSongs;
  indexChanged ||= prunedSongs > 0;
  for (const path of vanished) {
    // A vanished *folder* takes its subtree with it, on both planes. A one-level
    // delete would leave the folder's own songs behind, and their `dir_path` is
    // deeper than the folder — so they would stay indexed, pointing at files that
    // no longer exist, which is the entire failure this prune exists to prevent.
    const removedNodes = await deps.nodes.deleteSubtree(library.id, path);
    const removedSubtree = await deps.songs.deleteSubtree(library.id, path);
    writes += removedNodes + removedSubtree;
    indexChanged ||= removedNodes > 0 || removedSubtree > 0;
  }

  return { rowsWritten: writes, indexChanged };
}

export { reconcileFolder };
