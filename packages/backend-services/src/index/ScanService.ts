/**
 * The chunked, incremental, resumable scan.
 *
 * ### How a scan runs at all
 *
 * A recursive `PROPFIND` of a real library is thousands of subrequests, and
 * Workers cap them per invocation — 50 external on the Free plan, 10,000 on Paid.
 * So the scan is **chunked**: `startScan` seeds a frontier, and each subsequent
 * `getScanStatus` poll advances one chunk.
 *
 * The consequence is stated rather than hidden: **with no client polling, the scan
 * does not advance.** There is no cron, no queue, and no Durable Object in v1.
 * That matches how Subsonic clients already behave — they poll `getScanStatus`
 * during a scan — and the upgrade path (Cron Trigger → Queues → DO) is a change to
 * this one class.
 *
 * ### Why a chunk is bounded, and why by measured requests
 *
 * A chunk was "however many folders `SCAN_CHUNK_FOLDERS` names", walked
 * sequentially with nothing checked. On an origin answering a ranged `GET` in
 * 2.2 s that is 88 seconds, the client gives up at 45, and the work finishes
 * server-side where nobody is watching — so a client that backs off stops
 * advancing the scan by construction. Enrichment then moved per-track range reads
 * *inside* that same loop, taking a chunk from 40 subrequests to 1,640.
 *
 * So a chunk now carries a `ScanBudget` with a request ceiling and a wall-clock
 * deadline, and the loop **leaves early** rather than running itself out. The
 * frontier lives in D1, so a folder this chunk did not open is still there for the
 * next poll: leaving is a normal outcome, not a failure. See `scanBudget.ts`.
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
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource } from '@edge-sonic/webdav';
import { reconcileFolder } from './scanFolder';
import { ScanBudget, stopReason } from './scanBudget';
import type { ChunkResult, ScanDeps } from './scanTypes';
import { LAST_ERROR_MAX } from './scanTypes';

class ScanService {
  constructor(private readonly deps: ScanDeps) {}

  /**
   * The budget one chunk runs under.
   *
   * A fresh object per call, because a budget is scoped to one invocation and
   * this service is a per-request singleton — sharing one across chunks would
   * make the second poll inherit the first poll's spending, and a scan would stop
   * after a single chunk however large the ceiling.
   */
  private budget(): ScanBudget {
    return new ScanBudget({ maxRequests: this.deps.chunkMaxRequests, deadlineMs: this.deps.chunkDeadlineMs });
  }

  /**
   * `startScan`: probe the root and decide whether there is anything to do.
   *
   * Deliberately does no further walking. Making `startScan` the expensive request
   * means a client that calls it and then times out has learned nothing about
   * progress.
   */
  public async start(library: LibraryRow): Promise<ChunkResult> {
    const state = await this.deps.scanState.ensure(library.id);
    const budget = this.budget();

    let root: DavResource | undefined;
    try {
      const listed = await (await this.deps.clientFor(library, () => budget.charge())).propfind('', { depth: 0, timeoutMs: this.deps.timeoutMs });
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
          webdavRequests: budget.spent,
          rowsWritten: 0,
          stoppedBy: null,
        };
      }
      return await this.failChunk(library, state, error, budget);
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
        webdavRequests: budget.spent,
        rowsWritten: 0,
        stoppedBy: null,
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
      webdavRequests: budget.spent,
      rowsWritten: 0,
      stoppedBy: null,
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
        stoppedBy: null,
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
        stoppedBy: null,
      };
    }

    const budget = this.budget();
    let rowsWritten = 0;
    let scanned = state.scanned_count;
    let foldersVisited = 0;

    try {
      for (const folder of frontier) {
        // One `PROPFIND` is the cost of the next unit of work, and it is checked
        // *before* it is issued. A folder skipped here stays `is_scanned = 0` and
        // is the first thing the next poll picks up, so leaving early loses
        // nothing and double-writes nothing.
        if (!budget.canAfford()) break;

        foldersVisited += 1;
        const listed = await this.listFolder(library, folder.path, budget);
        if (listed === null) {
          // The folder is gone. Removing its subtree is the prune half of the
          // design, scoped to a folder the scan already visited, so its cost is
          // proportional to the deletion rather than to library size.
          rowsWritten += await this.deps.nodes.deleteSubtree(library.id, folder.path);
          rowsWritten += await this.deps.songs.deleteInDirectoryNotIn(library.id, folder.path, []);
          scanned += 1;
          continue;
        }
        rowsWritten += await reconcileFolder(this.deps, library, folder, listed, budget);
        scanned += 1;
      }

      await this.deps.scanState.saveProgress(library.id, scanned, null);
      return {
        status: 'scanning',
        scanned,
        total: state.total_count,
        indexVersion: state.index_version,
        lastError: null,
        foldersVisited,
        webdavRequests: budget.spent,
        rowsWritten,
        // `frontier` when the loop ran out of folders to visit, and the bound that
        // cut it short otherwise — which is the fact an operator watching a scan
        // that is not finishing needs, and the two have different remedies.
        stoppedBy: stopReason(budget, foldersVisited < frontier.length),
      };
    } catch (error) {
      return await this.failChunk(library, state, error, budget, { rowsWritten, scanned, foldersVisited });
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
      // Which bound ended the *last* chunk is not persisted, so a read-only status
      // cannot report one. `null` is honest: this call did no work, so nothing
      // stopped it. The value is on the chunk itself, which the operator surface
      // reaches through `POST /user/libraries/:id/scan/step`.
      stoppedBy: null,
    };
  }

  private async failChunk(
    library: LibraryRow,
    state: ScanStateRow,
    error: unknown,
    budget: ScanBudget,
    partial?: { rowsWritten: number; scanned: number; foldersVisited: number },
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
      foldersVisited: partial?.foldersVisited ?? 0,
      // The budget's own count rather than a `?? 1` fallback: it measures every
      // request the failed chunk issued, including the ones that threw, which is
      // the number an operator needs to tell a credential failure from a ceiling.
      webdavRequests: budget.spent,
      rowsWritten: partial?.rowsWritten ?? 0,
      stoppedBy: null,
    };
  }

  private async listFolder(library: LibraryRow, path: string, budget: ScanBudget): Promise<DavResource[] | null> {
    const client = await this.deps.clientFor(library, () => budget.charge());
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
}

export { ScanService };
export type { ChunkResult, ScanStatus } from './scanTypes';
export { type ScanDeps } from './scanTypes';
