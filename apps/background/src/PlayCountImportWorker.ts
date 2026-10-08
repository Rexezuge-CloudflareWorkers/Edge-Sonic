/**
 * `PlayCountImportWorker` — the unbounded half of an import.
 *
 * ### Why this is a Durable Object and not more Workflow steps
 *
 * **Because play counts have no bulk endpoint and the step ceiling is finite.** There is no
 * `getPlayCounts` in Subsonic or OpenSubsonic: `playCount` is an *attribute on a song*, so the
 * only way to read them off another server is to enumerate its albums and fetch each one. That
 * is ~1 remote call per album, and Workflows Free allows **1,024 steps per instance** at 10 ms of
 * CPU each. An 80-album library fits; a 2,000-album library does not complete in one run.
 *
 * A DO has no step ceiling, and — measured on 2026-10-05, and the reason this design works at
 * all — **each alarm invocation gets a fresh 50-subrequest external budget**. So the walk does
 * one bounded batch per alarm, for as long as it takes. See
 * `docs/issues/subrequest-budgets-are-two-not-one.md`.
 *
 * ### One batch per alarm, and the batch is bounded twice
 *
 * By the subrequest ceiling and by the wall-clock deadline, and the loop checks both **before**
 * each album — because a batch that starts an album it cannot finish does not get a slow album,
 * it gets a terminated invocation whose work is lost. `SUBSREQUESTS_PER_ALBUM_BASE` is the whole
 * cost of one album's step, not its one `getAlbum` call, for that reason alone.
 *
 * ### Two records of the walk's position, and only one of them resumes it
 *
 * - **DO storage** (`WalkProgress.albums`) is the resume point. `listAlbums` takes an offset, so
 *   the position is a count of albums already fetched and a restart would re-read the page from
 *   there rather than re-add counts.
 * - **A row in D1** (`import_play_count_progress`) is what the **operator's page** reads, and it is
 *   not a resume point. `GET /user/import/:id` polls that row and cannot address this object, so the
 *   walk publishing only to its own storage meant `playCounts: null` for every real import. See
 *   `playCountProgress.ts`, which is where the writing half lives.
 *
 * The published row advances by a **delta**, for the reason `saveProgress` is: two overlapping
 * batches would each publish their own total and the smaller would win, so the number an operator
 * watches would go **backwards** while the work was being done.
 *
 * ### Counts are absolute, written here and only here
 *
 * `PlayCountDAO.setPlayCounts` overwrites rather than increments. `recordPlay` increments and is
 * right to — a scrobble *is* an event — but an import is the current count read off another
 * server, and adding would make "imported twice" indistinguishable from "played twice" on every
 * track in the library.
 *
 * ### The alarm handler cannot reject
 *
 * Same reason `ScanWorker.alarm` cannot. Cloudflare retries a throwing alarm a bounded number of
 * times and then drops it, so a fault that escapes here ends the walk with the run still saying
 * `running` — and an operator watching a status that promises progress no longer exists. So the
 * failure is **recorded** and the alarm re-armed, which is what turns a fault into a bounded
 * retry instead of a wedge.
 */
import { DurableObject } from 'cloudflare:workers';
import { SCAN_CHUNK_SUBSREQUEST_BUDGET, SUBSREQUESTS_PER_FOLDER_BASE } from '@edge-sonic/backend-runtime/config';
import { isD1DailyLimitError } from '@edge-sonic/backend-data/utils';
import { MAX_CONSECUTIVE_FAILURES } from '@edge-sonic/backend-services/index';
import { Tokens } from '@edge-sonic/backend-services/composition';
import type { LibraryScope } from '@edge-sonic/backend-data/dao';
import { createScanWorkerScope } from './ScanWorkerFactory';
import { createPlayCountStore, describeWalkFailure, retryDelayMs, dailyLimitWalkMessage } from './playCountRetry';
import type { WalkProgress } from './playCountRetry';
import { advanceProgress, ensureProgress, releaseProgress } from './playCountProgress';
import { walkAlbumPage } from './playCountWalk';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

const logger = createLogger('PlayCountImportWorker');

/**
The alarm's own payload: the run to walk.
*/
interface WalkRequest {
  readonly runId: string;
}

/**
One remote album's whole cost: the `getAlbum` call, the two match statements, and its writes.

Aliases the folder base cost rather than retyping `6`: one number for one unit of
work, owned by `subrequests.ts`, so the two cannot drift.
*/
const SUBSREQUESTS_PER_ALBUM_BASE = SUBSREQUESTS_PER_FOLDER_BASE;

/**
Albums one batch attempts, derived from the ceiling rather than typed beside the loop.
*/
const ALBUMS_PER_BATCH = Math.max(1, Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_ALBUM_BASE));

/**
The delay between batches. A pacing delay, not a work bound — the batch is bounded above.
*/
const ALARM_DELAY_MS = 1000;

class PlayCountImportWorker extends DurableObject<Cloudflare.Env> {
  /**
   * Begin (or re-point) the walk.
   *
   * Unconditional on the run id, for the same reason `ScanWorker.startScan` is: this is the one
   * entry point that legitimately re-points the object at a run, and every other path is a
   * continuation of the one it was started with.
   */
  public async start(request: WalkRequest): Promise<{ readonly runId: string }> {
    await this.ctx.storage.put('runId', request.runId);
    await this.ctx.storage.put<WalkProgress>('alarm', { albums: 0, songs: 0, unresolved: 0, finished: false, lastError: null, consecutiveFailures: 0 });
    await this.ctx.storage.setAlarm(Date.now());
    return { runId: request.runId };
  }

  /**
   * Progress, for the operator surface.
   *
   * A read off storage and **never** off D1's allowance, because this is the page an operator
   * polls while an import runs — and the whole reason a spent allowance is a pause rather than an
   * outage is that the answer to "what is happening" is available while D1 is refusing answers.
   */
  public async status(): Promise<{
    readonly runId: string | null;
    readonly albums: number;
    readonly songs: number;
    readonly unresolved: number;
    readonly finished: boolean;
    readonly lastError: string | null;
  }> {
    const [runId, progress] = await Promise.all([this.ctx.storage.get<string>('runId'), this.ctx.storage.get<WalkProgress>('alarm')]);
    return {
      runId: runId ?? null,
      albums: progress?.albums ?? 0,
      songs: progress?.songs ?? 0,
      unresolved: progress?.unresolved ?? 0,
      finished: progress?.finished ?? false,
      lastError: progress?.lastError ?? null,
    };
  }

  public override async alarm(): Promise<void> {
    try {
      await this.runBatch();
    } catch (error) {
      // Recorded, then re-armed within a bound. A throwing alarm is retried a bounded number
      // of times by the platform and then **dropped**, so a fault that escapes here leaves the
      // run saying `running` with nothing scheduled to advance it — the exact wedge
      // `ScanWorker.alarm` was fixed for. The re-arm below is bounded by
      // `MAX_CONSECUTIVE_FAILURES` rather than left to run for ever, which is what turned one
      // poison album's `requireComplete` refusal into a one-second loop in October 2026.
      const daily = isD1DailyLimitError(error);
      if (daily !== null) {
        await this.pauseForDailyLimit(daily.kind, daily.resetsAt, error);
        return;
      }
      const runId = await this.ctx.storage.get<string>('runId');
      const progress = (await this.ctx.storage.get<WalkProgress>('alarm')) ?? {
        albums: 0,
        songs: 0,
        unresolved: 0,
        finished: false,
        lastError: null,
        consecutiveFailures: 0,
      };
      const consecutiveFailures = (progress.consecutiveFailures ?? 0) + 1;
      const lastError = describeWalkFailure(error);
      logger.error(`batch failed (attempt ${consecutiveFailures} of ${MAX_CONSECUTIVE_FAILURES}): ${lastError}`, error);
      if (runId !== undefined && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.settle(runId, { ...progress, consecutiveFailures, lastError }, lastError);
        return;
      }
      await this.ctx.storage.put<WalkProgress>('alarm', { ...progress, consecutiveFailures, lastError });
      await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(consecutiveFailures, ALARM_DELAY_MS));
    }
  }

  /**
   * Hold the walk until the daily allowance resets, without spending the retry bound.
   *
   * A spent allowance resolves at midnight UTC by itself, so it is neither counted as a
   * fault (which would eventually settle a walk that needed no operator) nor re-armed in
   * a second (which re-runs the whole failure path ~86,400 times before the reset). The
   * run row update is best-effort: D1 is refusing writes on exactly this path, so a
   * refusal there must not lose the alarm the walk resumes on.
   */
  private async pauseForDailyLimit(kind: 'read' | 'write', resetsAt: number, error: unknown): Promise<void> {
    const runId = await this.ctx.storage.get<string>('runId');
    const progress = (await this.ctx.storage.get<WalkProgress>('alarm')) ?? {
      albums: 0,
      songs: 0,
      unresolved: 0,
      finished: false,
      lastError: null,
      consecutiveFailures: 0,
    };
    const lastError = dailyLimitWalkMessage(kind);
    logger.error(lastError, error);
    await this.ctx.storage.put<WalkProgress>('alarm', { ...progress, lastError });
    if (runId !== undefined) {
      try {
        const scope = createScanWorkerScope(this.env);
        const runs = await scope.get(Tokens.ImportRunDAO)();
        await runs.update(runId, { status: 'paused', lastError });
      } catch {
        // D1 is refusing: the DO pause above is the truth the walk resumes on, and the run
        // row is reconciled when the allowance returns.
      }
    }
    await this.ctx.storage.setAlarm(resetsAt);
  }

  /**
   * One bounded batch: up to {@link ALBUMS_PER_BATCH} albums, and up to the deadline.
   *
   * The budget check is `canAfford` against the **whole** album cost rather than the one call
   * about to be made, and it happens before each album. A batch that admits an album it cannot
   * finish does not get a slow album — it gets a terminated invocation with the rows before it
   * written and the ones after it lost, which is how a walk that reports progress can still
   * make none.
   */
  private async runBatch(): Promise<void> {
    const runId = await this.ctx.storage.get<string>('runId');
    if (runId === undefined) return;
    const progress = (await this.ctx.storage.get<WalkProgress>('alarm')) ?? {
      albums: 0,
      songs: 0,
      unresolved: 0,
      finished: false,
      lastError: null,
      consecutiveFailures: 0,
    };
    if (progress.finished) return;

    const scope = createScanWorkerScope(this.env);
    // **The scope's own meter**, with this batch's ceiling set on it — the same arrangement
    // `ScanBudget` uses, and for the same reason.
    //
    // The first version built a *local* `SubrequestCounter` for the batch and left the DAOs
    // charging the scope's. Two counters are two numbers that disagree, and the disagreement was
    // silent and total: `canAfford` saw 44 remaining on a meter nothing else had spent, while the
    // DAOs charged the scope's own 50 and `requireSubrequests` threw on album seven. The alarm
    // caught it, recorded "could not read the import source", and re-armed — so the walk reported
    // progress and made **none**, for ever.
    //
    // One meter, narrowed to this batch's budget, means the loop's `canAfford` and every charge
    // point below it are reading the same number. `reset()` is the scan's too: an alarm invocation
    // is a fresh unit of work.
    const meter = scope.get(Tokens.SubrequestMeter);
    meter.reset();
    meter.setCeiling(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    // The scan's deadline, reused rather than a second number: it is the wall-clock bound this
    // repository already derives for a bounded batch of work, and a second constant beside it would
    // be a number wrong the day that one moves.
    const deadline = Date.now() + scope.get(Tokens.AppConfig).getScanChunkDeadlineMs();

    const runs = await scope.get(Tokens.ImportRunDAO)();
    const run = await runs.findById(runId);
    if (run === null) return await this.settle(runId, progress, 'The import run no longer exists.');

    // The cursor the **operator's** status page reads — a different record from the walk's own DO
    // storage, because the page polls `GET /user/import/:id` and cannot address this object. It had a
    // DAO and no writer, so the field read `null` for every real import. See `playCountProgress.ts`.
    await ensureProgress(scope, runId);

    // The same service the Workflow used, for the same reason: one reader of one stored credential.
    // Both refusals — the source is gone, or its host is no longer permitted — **settle** rather than
    // re-arm, because neither becomes true again by waiting and the alarm's generic catch would
    // discard the real reason behind "could not read the import source".
    const opened = await scope.get(Tokens.ImportSourceService).clientFor(run.source_id);
    if (!opened.ok) return await this.settle(runId, progress, opened.reason);
    const remote = opened.client;

    const phaseContext = {
      runId,
      userId: run.target_user_id,
      // The walk resolves against **every** library the target user was granted, so a count
      // whose track lives in the second is matched rather than reported unmatched. The
      // alternative — `libraries[0]` — is the narrowing `SongIdLookupDAO` records for the play
      // queue, and it cost this walk every count outside the first library.
      libraryId: await this.libraryIdsFor(scope, run.target_user_id),
      store: createPlayCountStore(scope, run.target_user_id),
      remote: remote as never,
      matchAlbum: (libraryId: LibraryScope, albums: ReadonlyArray<{ id: string; name: string | null; artist: string | null }>) =>
        scope.get(Tokens.MatchRemoteAlbums)(libraryId, albums),
      matchArtist: (libraryId: LibraryScope, artists: ReadonlyArray<{ id: string; name: string | null }>) =>
        scope.get(Tokens.MatchRemoteArtists)(libraryId, artists),
      albumPageSize: ALBUMS_PER_BATCH,
    };

    // The page is fetched **once** and its albums walked from it, so a batch of seven albums
    // costs one enumeration call and seven `getAlbum` calls rather than seven of each. That is
    // the entire reason the per-album phase exists separately from the per-page one.
    const page = await remote.listAlbums(progress.albums, ALBUMS_PER_BATCH);
    if (page.length === 0) {
      await this.settle(runId, { ...progress, finished: true }, null);
      return;
    }

    const walked = await walkAlbumPage(phaseContext, page, { meter, deadline, costPerAlbum: SUBSREQUESTS_PER_ALBUM_BASE });
    const { albums: albumsThisBatch, songs: songsThisBatch, unresolved: unresolvedThisBatch, deferredForBudget } = walked;

    // A **short page** is the remote saying there is no next one. Recorded rather than left for
    // the operator to infer — a walk that ended for a reason nobody wrote down reads as a
    // walk that finished.
    const exhausted = page.length < ALBUMS_PER_BATCH && !deferredForBudget;
    const next: WalkProgress = {
      albums: progress.albums + albumsThisBatch,
      songs: progress.songs + songsThisBatch,
      unresolved: progress.unresolved + unresolvedThisBatch,
      finished: exhausted,
      lastError: null,
      consecutiveFailures: 0,
    };
    await this.ctx.storage.put<WalkProgress>('alarm', next);
    // Published in the same place the walk's own storage is written, and **not** at the end of the walk
    // — so an operator polling the route sees the count advance rather than jump from null to the
    // total hours later.
    await advanceProgress(scope, runId, page.at(-1)?.id ?? null, albumsThisBatch, songsThisBatch);
    if (run.status === 'paused') {
      await runs.update(runId, { status: 'running', lastError: null });
    }

    if (exhausted) {
      await this.settle(runId, next, null);
      return;
    }
    // Deferred with nothing written this batch means even the first album on a near-fresh
    // budget did not fit: no later alarm will have meaningfully more room, so re-arming
    // would loop the same page for ever. Name the album and settle instead.
    if (deferredForBudget && albumsThisBatch === 0) {
      const first = page[0];
      const name = first === undefined ? 'unknown album' : (first.name ?? first.id);
      const reason = `The play-count walk stopped on album "${name}": it needs more database statements than one alarm can issue.`;
      await this.settle(runId, { ...next, lastError: reason }, reason);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
  }

  /**
   * The one library the walk resolves against.
   *
   * The **first** granted library, and that is a limitation worth naming rather than hiding: a
   * walk cannot span two libraries, because every lookup is scoped to one and a library-less
   * resolution would let a track from a library the target user cannot see through. A user
   * granted two libraries has their counts matched against the first, and the rest appear in the
   * report rather than silently resolving somewhere else.
   */
  private async libraryIdsFor(scope: ReturnType<typeof createScanWorkerScope>, userId: string): Promise<readonly string[]> {
    // The batch's scope, not a fresh one: a second scope would hold a second meter, and the
    // grant read would spend nothing the batch's budget could see.
    const granted = await scope.get(Tokens.LibraryService).listForUser(userId);
    // Every granted library, not the first: the walk resolves foreign ids against the scope, and
    // `libraries[0]` reported every count in the second library as unmatched — the same
    // narrowing `SongIdLookupDAO` records for the play queue.
    return granted.map((row) => row.id);
  }

  /**
   * Settle the run once the walk is over.
   *
   * `failed` with a reason when the walk could not finish and `completed` when it could. Those
   * are different answers because they ask the operator for different things: a failed walk needs
   * somebody to look, a completed one does not. Collapsing them is how a run sits `running` for
   * ever with nothing scheduled to advance it — the exact defect `ScanWorker.alarm`\'s `try`
   * guard exists to prevent.
   */
  private async settle(runId: string, progress: WalkProgress, error: string | null): Promise<void> {
    const scope = createScanWorkerScope(this.env);
    const runs = await scope.get(Tokens.ImportRunDAO)();
    await this.ctx.storage.put<WalkProgress>('alarm', { ...progress, finished: true, lastError: error });
    // The published cursor is released once the walk is terminal, so a resumed run does not resume from
    // a position the next walk will pass. Best-effort — see `playCountProgress.ts` for why this one
    // swallows and the other two do not.
    await releaseProgress(scope, runId);
    await runs.update(runId, {
      status: error === null ? 'completed' : 'failed',
      lastError: error,
      finishedAt: Math.floor(Date.now() / 1000),
    });
    // Terminal: nothing is scheduled to resume a finished walk, so leaving the alarm armed would
    // wake this object once more to do nothing.
    await this.ctx.storage.deleteAlarm();
  }
}

export { PlayCountImportWorker, ALBUMS_PER_BATCH, SUBSREQUESTS_PER_ALBUM_BASE };
export type { WalkRequest };
export type { WalkProgress } from './playCountRetry';