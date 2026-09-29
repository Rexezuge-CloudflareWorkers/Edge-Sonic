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
import { basename, isAudioFile, suffixOf } from './TreeService';
import { enrichChanged } from './scanEnrichment';
import type { ScanBudget } from './scanBudget';
import type { ScanDeps, ScanNodeInput, ScanSongInput } from './scanTypes';

/**
 * Reconcile one folder's listing: write what changed, prune what vanished.
 *
 * Two decisions per child:
 *
 * - **a collection whose mtime matches its stored value is written with
 *   `is_scanned = 1`**, so the scan never opens it. This is what makes a
 *   one-album change cost one request instead of one per folder.
 * - **a file is written only when its size or mtime moved.** `upsertFileFacts`
 *   deliberately leaves derived metadata alone, so a redundant write would spend
 *   a row to rewrite values that are already correct.
 */
async function reconcileFolder(deps: ScanDeps, library: LibraryRow, folder: NodeRow, resources: readonly DavResource[], budget: ScanBudget): Promise<number> {
  // The folder's own entry, straight from this listing. Its mtime is the *fresh*
  // one and is what gets written back — writing the frontier row's stored value
  // instead would leave the index permanently one version behind, so the next
  // `startScan` would see a mismatch and re-walk the whole library every time.
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

    nodeInputs.push({
      libraryId: library.id,
      path,
      parentPath: folder.path,
      name,
      mtimeMs: resource.lastModifiedMs,
      etag: resource.etag,
      depth: path.split('/').length,
      // A new or moved folder must be opened; an unmoved one must not.
      isScanned: resource.isCollection ? !changed : true,
    });

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

  let writes = 0;
  // The folder itself leaves the frontier, carrying the mtime this listing
  // reported. That value is what the next `startScan`'s root probe compares
  // against, so it has to be the fresh one.
  writes += await deps.nodes.upsertMany([
    {
      libraryId: library.id,
      path: folder.path,
      parentPath: folder.parent_path,
      name: folder.name,
      mtimeMs: self?.lastModifiedMs ?? folder.mtime_ms,
      etag: self?.etag ?? folder.etag,
      depth: folder.depth,
      isScanned: true,
    },
    ...nodeInputs,
  ]);
  if (songInputs.length > 0) writes += await deps.songs.upsertFileFacts(songInputs);

  // Fill in what a range read knows and a `PROPFIND` does not: duration, bitrate, and
  // the text tags that `getArtists`, `getAlbumList2`, `getGenres` and `search3` all
  // group on. Without this, a browsing client sees `duration: 0` and no artist on
  // every track until it happens to open one — and the aggregates stay empty, because
  // there is nothing to group.
  //
  // Only the rows this listing changed, which is exactly the set whose `enriched_at`
  // the upsert just cleared. An unchanged track costs nothing.
  await enrichChanged(library, songInputs, deps.enrichSong, deps.enrichMaxPerFolder, budget);

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

  writes += await deps.songs.deleteInDirectoryNotIn(library.id, folder.path, songPaths);
  for (const path of vanished) {
    // A vanished *folder* takes its subtree with it, on both planes. A one-level
    // delete would leave the folder's own songs behind, and their `dir_path` is
    // deeper than the folder — so they would stay indexed, pointing at files that
    // no longer exist, which is the entire failure this prune exists to prevent.
    writes += await deps.nodes.deleteSubtree(library.id, path);
    writes += await deps.songs.deleteSubtree(library.id, path);
  }

  return writes;
}

export { reconcileFolder };
