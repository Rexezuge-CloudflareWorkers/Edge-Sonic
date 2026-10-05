/**
 * The chunked, incremental, resumable scan.
 *
 * ### How a scan runs at all
 *
 * A recursive `PROPFIND` of a real library is thousands of subrequests, and
 * Workers cap them per invocation — 50 external on the Free plan, 10,000 on Paid.
 * So the scan is **chunked**: `startScan` seeds a frontier, and each subsequent
 * chunk advances one bounded unit of work.
 *
 * The consequence is stated rather than hidden: **with no advancer running, the
 * scan does not advance.** In production the advancer is `ScanWorker`
 * (`apps/background`, one Durable Object per library, alarm-chained). Without the
 * `SCAN` binding the advancer is a direct `step()` call from `getScanStatus` or
 * `POST .../scan/step` — the legacy client-driven path the suite exercises.
 * That matches how Subsonic clients already behave — they poll `getScanStatus`
 * during a scan — and the DO is a change to the advancer, not to this class.
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
 *
 * ### A failure is retried, and the retry is bounded
 *
 * A failure leaves the frontier where it was and the next poll resumes, so that claim
 * is a property of the code rather than of this comment. It used to be neither:
 * `step` short-circuited on any status other than `scanning`, and `fail` sets
 * `failed`, so one bad chunk ended a scan permanently with the frontier sitting
 * untouched in D1. Eighty albums stayed at one visited folder, and `getScanStatus` —
 * which derives `scanning` from this status — answered `scanning: false`, which every
 * client reads as *finished*. `MAX_CONSECUTIVE_FAILURES` is the other half: retrying a
 * transient fault is the entire point, and retrying a permanent one for ever is a loop
 * that spends the operator's WebDAV requests to reach the same conclusion every time.
 */
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import type { DavResource } from '@edge-sonic/webdav';
import { reconcileFolder } from './scanFolder';
import { backfill, settle } from './scanPrelude';
import { start } from './scanStart';
import { ScanBudget, stopReason } from './scanBudget';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import { SUBSREQUESTS_PER_FOLDER_BASE } from '@edge-sonic/backend-runtime/config';
import { describeFailure, MAX_CONSECUTIVE_FAILURES, storedStatus, unrecordedFailure } from './scanRetry';
import type { ChunkResult, ScanDeps } from './scanTypes';



class ScanService {
  constructor(private readonly deps: ScanDeps) {}

  /**
   * The budget one chunk runs under.
   *
   * A fresh wrapper per call, because a budget is scoped to one chunk and this service is a
   * per-request singleton — sharing one across chunks would make the second poll inherit the
   * first poll's spending, and a scan would stop after a single chunk however large the
   * ceiling. The **counter** is not fresh: it is the request scope's, because that is the
   * object every D1 statement and KV operation is charging, and a budget reading a different
   * counter from the one the DAOs write to would be a budget reading fiction.
   */
  private budget(): ScanBudget {
    return new ScanBudget({
      meter: this.deps.subrequests,
      maxRequests: this.deps.chunkMaxRequests,
      deadlineMs: this.deps.chunkDeadlineMs,
    });
  }

  /**
   * `startScan`: probe the root, seed the frontier, and decide whether there is anything to
   * walk. The decision and the cheap path are `scanStart.ts`; this is the seam.
   */
  public async start(library: LibraryRow): Promise<ChunkResult> {
    return await start(this.deps, library, this.budget(), async (row, state, error, budget) => await this.failChunk(row, state, error, budget));
  }

  /**
   * Advance one chunk. Called from `ScanWorker.stepOnce` (alarm-driven) or, without
   * the `SCAN` binding, directly from `getScanStatus` (client-driven).
   */
  public async step(library: LibraryRow): Promise<ChunkResult> {
    // ### The `try` opens here, not below
    //
    // It used to open after the frontier read, which left five awaited calls — `ensure`,
    // `derivePending`, `listFrontier`, `fail`, `complete` — able to reject *outside* it.
    // A rejection there propagates out of `step`, and in production the only caller is
    // `ScanWorker.alarm`, which had no handler of its own: the alarm was consumed, the
    // re-arm never ran, and D1's `scan_state.status` was still `scanning`. So
    // `getStatus` answered `scanning: true` for ever — which every client reads as *keep
    // polling* — while nothing was scheduled to answer. Nothing reconciles the two
    // stores: the alarm lives in DO storage, the status in D1, and `getAlarm()` is called
    // from nowhere. `startScan` was the only recovery and it runs at client startup, not
    // while browsing.
    //
    // A failure that cannot be recorded is also a failure nobody can diagnose, so the
    // whole body is inside the guard: a transient D1 error becomes one counted retry with
    // a `last_error` an operator can read, and `isAdvancing('failed')` keeps the chain
    // armed so the retry budget — not an unbounded loop — is what bounds it.
    // Declared outside the `try` because the `catch` reads them, and because `state` being
    // `null` **is** the signal for "the fault happened before any state was read" — a
    // second boolean for the same fact would be free to disagree with it.
    let state: ScanStateRow | null = null;
    let budget: ScanBudget | undefined;
    let derivedRows = 0;
    let rowsWritten = 0;
    let scanned = 0;
    let foldersVisited = 0;

    try {
      state = await this.deps.scanState.ensure(library.id);
      budget = this.budget();
      derivedRows = await backfill(this.deps, library.id, budget);

      const frontier = await this.deps.nodes.listFrontier(library.id, this.deps.chunkFolders);
      const settled = await settle(this.deps, library, state, derivedRows, frontier);
      // A `ChunkResult` means the chunk is already answered — `stalled`, `idle`, or
      // `unableToAdvance` — and every one of those reasons is a return, not a value to
      // carry on from. `null` means there is a frontier to walk.
      if (settled !== null) return settled;

      rowsWritten = derivedRows;
      scanned = state.scanned_count;

      for (const folder of frontier) {
        // The cost of the next unit of work, checked *before* it is issued, and it is a
        // folder's whole base cost rather than the one `PROPFIND` it used to check for.
        //
        // `SUBSREQUESTS_PER_FOLDER_BASE` is the part a folder costs whatever it contains: one
        // `PROPFIND`, two `listChildren`, the `upsertMany` for its own row, its songs' upsert
        // and the prune. Checking only the `PROPFIND` is what let a chunk start a folder it
        // could not finish — and "could not finish" on the Free plan is not a slow folder, it
        // is a terminated invocation.
        //
        // A folder skipped here stays `is_scanned = 0` and is the first thing the next poll
        // picks up, so leaving early loses nothing and double-writes nothing.
        if (!budget.canAfford(SUBSREQUESTS_PER_FOLDER_BASE)) break;

        foldersVisited += 1;
        const listed = await this.listFolder(library, folder.path, budget);
        if (listed === null) {
          // The folder is gone. Removing its subtree is the prune half of the
          // design, scoped to a folder the scan already visited, so its cost is
          // proportional to the deletion rather than to library size.
          rowsWritten += await this.deps.nodes.deleteSubtree(library.id, folder.path);
          rowsWritten += (await this.deps.songs.deleteInDirectoryNotIn(library.id, folder.path, [])).changes;
          scanned += 1;
          continue;
        }
        rowsWritten += await reconcileFolder(this.deps, library, folder, listed, budget);
        scanned += 1;
      }

      // The **delta**, not the running total: `saveProgress` increments in its own statement
      // because a chunk can be overlapped — an operator `POST` while the alarm is live — and
      // a read-modify-write of `scanned_count` across that gap publishes the smaller of the
      // two. `scanned` above is still the absolute count the result reports; only the write
      // is a delta. The two are deliberately not the same value, and conflating them is the
      // lost update.
      await this.deps.scanState.saveProgress(library.id, foldersVisited, null);
      return {
        status: 'scanning',
        scanned,
        total: state.total_count,
        indexVersion: state.index_version,
        lastError: null,
        foldersVisited,
        subrequests: budget.spend(),
        rowsWritten,
        // `frontier` when the loop ran out of folders to visit, and the bound that
        // cut it short otherwise — which is the fact an operator watching a scan
        // that is not finishing needs, and the two have different remedies.
        stoppedBy: stopReason(budget, foldersVisited < frontier.length),
      };
    } catch (error) {
      // `budget` and `state` are only meaningful once `ensure` succeeded. A failure in
      // `ensure` itself — the one call that would have to work for `failChunk` to record
      // anything — is reported as a fresh budget over an unknown row rather than
      // rethrown, so the *caller* cannot be left holding an unhandled rejection that
      // skips its re-arm. `failChunk`'s own `scanState.fail` is inside the same store,
      // so it may also fail; that is caught here and turned into a result, because a
      // handler that rejects is the wedge this whole restructure exists to close.
      if (budget === undefined) budget = this.budget();
      if (state === null) {
        const message = describeFailure(error);
        try {
          const consecutiveFailures = await this.deps.scanState.fail(library.id, message);
          return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? { ...unrecordedFailure(message), status: 'stalled' } : unrecordedFailure(message);
        } catch (persistError) {
          // D1 refused the fail *and* the record of the fail, so the retry counter cannot
          // be incremented and nothing knows how many attempts have been made.
          //
          // Reported as `failed`, not `stalled`, and that distinction is the whole point.
          // `stalled` is the terminal status — `isAdvancing` is false for it, so the caller
          // deletes the alarm — which would turn one D1 blip into a scan that never resumes,
          // with the frontier sitting intact and unread in D1. That is the shipped defect
          // this whole restructure exists to prevent, reproduced one layer down by the
          // obvious way to handle "cannot record". `failed` keeps the chain armed, and the
          // inter-alarm delay is what bounds the retries here: one attempt a second against
          // a store that is refusing writes. The counter cannot, so the delay must. It stops
          // the moment D1 recovers, which is the correct time for it to stop.
          return unrecordedFailure(`${message} (the failure could not be recorded: ${describeFailure(persistError)})`);
        }
      }
      return await this.failChunk(library, state, error, budget, { rowsWritten, scanned, foldersVisited });
    }
  }

    public async status(libraryId: string): Promise<ChunkResult> {
    const state = await this.deps.scanState.ensure(libraryId);
    return {
      // A read-only status reports `stalled` from the stored counter, so an operator
      // opening the page sees the same terminal state a poll would have reported —
      // rather than a `failed` that reads as "retrying" when it is not. The mapping
      // itself is `storedStatus`, shared with the operator's library list so the two
      // surfaces cannot disagree about whether a scan is over.
      status: storedStatus(state),
      scanned: state.scanned_count,
      total: state.total_count,
      indexVersion: state.index_version,
      // Reported for `failed` only: an `idle` row's `last_error` is already `NULL`,
      // and an `idle` scan is the state an operator is not asking about.
      lastError: state.status === 'failed' ? state.last_error : null,
      foldersVisited: 0,
      subrequests: NO_SUBREQUESTS_SPENT,
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
    // The frontier is left where it was, and `step` re-enters a failed scan rather
    // than treating the status as terminal — so "the next poll resumes" is now a
    // property of the code and not of this comment. The text can be upstream-controlled,
    // so it is bounded to the same length the DAO persists, and the *bounded* value is
    // what is returned: reporting the untruncated string would show the operator more
    // than the database actually holds.
    const message = describeFailure(error);
    const consecutiveFailures = await this.deps.scanState.fail(library.id, message);
    const result: ChunkResult = {
      status: 'failed',
      scanned: partial?.scanned ?? state.scanned_count,
      total: state.total_count,
      indexVersion: state.index_version,
      lastError: message,
      foldersVisited: partial?.foldersVisited ?? 0,
      // The budget's own count rather than a `?? 1` fallback: it measures every
      // request the failed chunk issued, including the ones that threw, which is
      // the number an operator needs to tell a credential failure from a ceiling.
      subrequests: budget.spend(),
      rowsWritten: partial?.rowsWritten ?? 0,
      stoppedBy: null,
    };
    // The last permitted failure reports as `stalled`, because it will not be retried
    // and `failed` elsewhere means exactly that it will be. Both carry the reason; only
    // this one is the end of the road without an explicit `startScan`.
    return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? { ...result, status: 'stalled' } : result;
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
