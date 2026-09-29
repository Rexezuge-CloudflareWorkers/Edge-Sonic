/**
 * The chunked, incremental, resumable scan.
 *
 * ### How a scan runs at all
 *
 * A recursive `PROPFIND` of a real library is thousands of subrequests, and
 * Workers allow 1,000 per request. So the scan is **chunked**: `startScan` seeds a
 * frontier, and each subsequent `getScanStatus` poll advances one chunk.
 *
 * The consequence is stated rather than hidden: **with no client polling, the scan
 * does not advance.** There is no cron, no queue, and no Durable Object in v1.
 * That matches how Subsonic clients already behave — they poll `getScanStatus`
 * during a scan — and the upgrade path (Cron Trigger → Queues → DO) is a change to
 * this one class.
 *
 * ### The algorithm, and why it is cheap when nothing changed
 *
 * A WebDAV server bumps a collection's `getlastmodified` when any child changes,
 * so **one `PROPFIND Depth: 0` on the library root answers "has anything moved?"**.
 * If the root's mtime matches the value stored by the last completed scan, the
 * whole subtree is unchanged and the scan is over:
 *
 * > An unchanged rescan costs one subrequest and **zero D1 rows**.
 *
 * When the root *has* moved, the scan reconciles it (`Depth: 1`) and each child
 * folder's mtime decides whether to descend. A child whose mtime matches its
 * stored value is written with `is_scanned = 1` and never opened. So the cost of a
 * scan is one request per *changed* folder, not per folder.
 *
 * `is_scanned` is therefore the incrementality mechanism, and it is written as
 * part of the node's single `upsert` rather than as a follow-up `patch` — a second
 * write would spend a second row from a 5,000/day allowance.
 *
 * ### Why a cold scan can exceed the free tier, and why that is survivable
 *
 * A 1,000-folder / 5,000-track library writes ~6,100 rows, against a 5,000/day
 * allowance. Because the frontier lives in D1 and the scan is resumable, the
 * overshoot degrades to *"the scan takes a couple of days"* rather than *"the scan
 * fails"*.
 */
import type { LibraryRow, NodeRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import { encodeId, IdKind } from '@edge-sonic/subsonic';
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource } from '@edge-sonic/webdav';
import { basename, isAudioFile, suffixOf } from './TreeService';
import { enrichChanged } from './scanEnrichment';
import type { ChunkResult, ScanDeps, ScanNodeInput, ScanSongInput } from './scanTypes';
import { LAST_ERROR_MAX } from './scanTypes';

class ScanService {
  constructor(private readonly deps: ScanDeps) {}

  /**
   * `startScan`: probe the root and decide whether there is anything to do.
   *
   * Deliberately does no further walking. Making `startScan` the expensive request
   * means a client that calls it and then times out has learned nothing about
   * progress.
   */
  public async start(library: LibraryRow): Promise<ChunkResult> {
    const state = await this.deps.scanState.ensure(library.id);

    let root: DavResource | undefined;
    try {
      const client = await this.deps.clientFor(library);
      const listed = await client.propfind('', { depth: 0, timeoutMs: this.deps.timeoutMs });
      root = listed.find((resource) => toLibraryPath(resource.path, library.root_path) === '') ?? listed[0];
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) {
        // The library root is gone. Clear the index rather than leaving rows that
        // point at paths which no longer exist.
        await this.deps.nodes.deleteSubtree(library.id, '');
        const indexVersion = await this.deps.scanState.complete(library.id, 0);
        return {
          status: 'idle',
          scanned: 0,
          total: 0,
          indexVersion,
          lastError: null,
          foldersVisited: 0,
          webdavRequests: 1,
          rowsWritten: 0,
        };
      }
      return await this.failChunk(library, state, error);
    }

    const rootMtime = root?.lastModifiedMs ?? null;
    const stored = await this.deps.nodes.find(library.id, '');

    // A completed scan whose root mtime still matches means nothing below it
    // moved. This comparison against the *stored* value is the entire reason a
    // rescan is free.
    if (state.status === 'idle' && state.scanned_count > 0 && rootMtime !== null && stored?.mtime_ms === rootMtime) {
      return {
        status: 'idle',
        scanned: state.scanned_count,
        total: state.scanned_count,
        indexVersion: state.index_version,
        lastError: null,
        foldersVisited: 0,
        webdavRequests: 1,
        rowsWritten: 0,
      };
    }

    // Seed the frontier with the root. Every other folder joins it as its parent is
    // reconciled, which is what bounds a chunk's subrequest count.
    await this.deps.nodes.upsertMany([
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

    await this.deps.scanState.markScanning(library.id, 0);
    return {
      status: 'scanning',
      scanned: 0,
      total: 0,
      indexVersion: state.index_version,
      lastError: null,
      foldersVisited: 0,
      webdavRequests: 1,
      rowsWritten: 0,
    };
  }

  /**
   * Advance one chunk. Called from `getScanStatus`, which is what makes the scan
   * client-driven.
   */
  public async step(library: LibraryRow): Promise<ChunkResult> {
    const state = await this.deps.scanState.ensure(library.id);
    if (state.status !== 'scanning') {
      // A poll with no scan running is the common case — a client opening the app —
      // so it must not touch the network or write anything.
      //
      // The stored `last_error` is carried through here specifically: this is the
      // path a client takes after a failure, and it is the only place the reason
      // can still be recovered without another failing request.
      return {
        status: state.status === 'failed' ? 'failed' : 'idle',
        scanned: state.scanned_count,
        total: state.total_count,
        indexVersion: state.index_version,
        lastError: state.last_error,
        foldersVisited: 0,
        webdavRequests: 0,
        rowsWritten: 0,
      };
    }

    const frontier = await this.deps.nodes.listFrontier(library.id, this.deps.chunkFolders);
    if (frontier.length === 0) {
      const indexVersion = await this.deps.scanState.complete(library.id, state.scanned_count);
      return {
        status: 'idle',
        scanned: state.scanned_count,
        total: state.total_count,
        indexVersion,
        lastError: null,
        foldersVisited: 0,
        webdavRequests: 0,
        rowsWritten: 0,
      };
    }

    let webdavRequests = 0;
    let rowsWritten = 0;
    let scanned = state.scanned_count;

    try {
      for (const folder of frontier) {
        webdavRequests += 1;
        const listed = await this.listFolder(library, folder.path);
        if (listed === null) {
          // The folder is gone. Removing its subtree is the prune half of the
          // design, scoped to a folder the scan already visited, so its cost is
          // proportional to the deletion rather than to library size.
          rowsWritten += await this.deps.nodes.deleteSubtree(library.id, folder.path);
          rowsWritten += await this.deps.songs.deleteInDirectoryNotIn(library.id, folder.path, []);
          scanned += 1;
          continue;
        }
        rowsWritten += await this.absorb(library, folder, listed);
        scanned += 1;
      }

      await this.deps.scanState.saveProgress(library.id, scanned, null);
      return {
        status: 'scanning',
        scanned,
        total: state.total_count,
        indexVersion: state.index_version,
        lastError: null,
        foldersVisited: frontier.length,
        webdavRequests,
        rowsWritten,
      };
    } catch (error) {
      return await this.failChunk(library, state, error, { webdavRequests, rowsWritten, scanned });
    }
  }

  public async status(libraryId: string): Promise<ChunkResult> {
    const state = await this.deps.scanState.ensure(libraryId);
    return {
      status: state.status === 'scanning' ? 'scanning' : state.status === 'failed' ? 'failed' : 'idle',
      scanned: state.scanned_count,
      total: state.total_count,
      indexVersion: state.index_version,
      // Reported for `failed` only: an `idle` row's `last_error` is already `NULL`,
      // and an `idle` scan is the state an operator is not asking about.
      lastError: state.status === 'failed' ? state.last_error : null,
      foldersVisited: 0,
      webdavRequests: 0,
      rowsWritten: 0,
    };
  }

  private async failChunk(
    library: LibraryRow,
    state: ScanStateRow,
    error: unknown,
    partial?: { webdavRequests: number; rowsWritten: number; scanned: number },
  ): Promise<ChunkResult> {
    // The frontier is left where it was, so the next poll resumes rather than
    // restarting. The text can be upstream-controlled, so it is bounded to the
    // same length the DAO persists, and the *bounded* value is what is returned:
    // reporting the untruncated string would show the operator more than the
    // database actually holds.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX);
    await this.deps.scanState.fail(library.id, message);
    return {
      status: 'failed',
      scanned: partial?.scanned ?? state.scanned_count,
      total: state.total_count,
      indexVersion: state.index_version,
      lastError: message,
      foldersVisited: 0,
      webdavRequests: partial?.webdavRequests ?? 1,
      rowsWritten: partial?.rowsWritten ?? 0,
    };
  }

  private async listFolder(library: LibraryRow, path: string): Promise<DavResource[] | null> {
    const client = await this.deps.clientFor(library);
    try {
      return await client.propfind(path, { depth: 1, timeoutMs: this.deps.timeoutMs });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Only "absent" is treated as a deletion. A 401 or 5xx must not be read as
      // "the folder is gone", or a transient origin outage deletes a library.
      if (status === 404 || status === 410) return null;
      throw error;
    }
  }

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
  private async absorb(library: LibraryRow, folder: NodeRow, resources: readonly DavResource[]): Promise<number> {
    // The folder's own entry, straight from this listing. Its mtime is the *fresh*
    // one and is what gets written back — writing the frontier row's stored value
    // instead would leave the index permanently one version behind, so the next
    // `startScan` would see a mismatch and re-walk the whole library every time.
    const self = resources.find((resource) => toLibraryPath(resource.path, library.root_path) === folder.path);

    // One query for the folder's existing children; every comparison below is then
    // in-memory. A `find` per child is 2N round trips for a 500-track album.
    const existing = new Map((await this.deps.nodes.listChildren(library.id, folder.path)).map((node) => [node.path, node]));

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
    writes += await this.deps.nodes.upsertMany([
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
    if (songInputs.length > 0) writes += await this.deps.songs.upsertFileFacts(songInputs);

    // Fill in what a range read knows and a `PROPFIND` does not: duration, bitrate, and
    // the text tags that `getArtists`, `getAlbumList2`, `getGenres` and `search3` all
    // group on. Without this, a browsing client sees `duration: 0` and no artist on
    // every track until it happens to open one — and the aggregates stay empty, because
    // there is nothing to group.
    //
    // Only the rows this listing changed, which is exactly the set whose `enriched_at`
    // the upsert just cleared. An unchanged track costs nothing.
    await enrichChanged(library, songInputs, this.deps.enrichSong, this.deps.enrichMaxPerFolder);

    // Prune. Unconditional, and both calls return 0 without issuing a statement when
    // nothing vanished.
    //
    // The song prune must NOT be guarded on `songPaths.length > 0`: that guard skips
    // the prune exactly when a folder has lost *every* track, which is the case that
    // matters most — an album deleted on the WebDAV side would keep all of its rows
    // and go on appearing in `search3` forever.
    const keptPaths = new Set(childPaths);
    const vanished = (await this.deps.nodes.listChildren(library.id, folder.path))
      .map((node) => node.path)
      .filter((path) => path !== folder.path && !keptPaths.has(path));

    writes += await this.deps.songs.deleteInDirectoryNotIn(library.id, folder.path, songPaths);
    for (const path of vanished) {
      // A vanished *folder* takes its subtree with it, on both planes. A one-level
      // delete would leave the folder's own songs behind, and their `dir_path` is
      // deeper than the folder — so they would stay indexed, pointing at files that
      // no longer exist, which is the entire failure this prune exists to prevent.
      writes += await this.deps.nodes.deleteSubtree(library.id, path);
      writes += await this.deps.songs.deleteSubtree(library.id, path);
    }

    return writes;
  }
}

export { ScanService };
export type { ChunkResult, ScanStatus } from './scanTypes';
export { type ScanDeps } from './scanTypes';
