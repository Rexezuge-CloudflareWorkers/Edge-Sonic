/**
 * One Durable Object per library: the **alarm-driven scan loop**, and nothing else.
 *
 * Facade (Git `RepoWorker` pattern): routing + composition only. The folder walk
 * lives in `ScanService`, and this class decides *where* it runs and chains the alarm
 * that advances the scan without a client polling. The pause and the day's write budget
 * live in `scanPause.ts`, for the same reason the walk lives in `ScanService`: this file
 * is a router, and a decision with a state machine in it does not belong in one.
 *
 * ### The request-path media work is `MediaWorker`, and the reason is the input gate
 *
 * Tag parsing and artwork were three methods here, and moving them is not tidiness. A Durable
 * Object handles one event at a time, so an alarm invocation walking the origin — up to
 * `SCAN_CHUNK_FOLDERS` folders inside `SCAN_CHUNK_DEADLINE_MS` — blocks every RPC to *this*
 * object. `getSong` and `getCoverArt` therefore waited for the chunk before they started, and
 * `coverArt` is handed `streamTimeoutMs` (30 s): a scan in flight could spend two thirds of an
 * artwork request's budget before the request began. Background work must not serialize behind a
 * user-facing request, so the media half has its own object and its own namespace. See
 * `MediaWorker.ts`, and the same argument already made for `IMPORT_DO` in the wrangler template.
 *
 * ### There is no `fetch` handler, and there was one
 *
 * It answered `GET /status?libraryId=…`, and **nothing ever called it** — every caller reached
 * `getStatus` over RPC, which is what `scanStubs.ts` hands out. So the class carried a second
 * route to one question, unreachable from any code path in this repository and covered by
 * nothing, and a DO handler answering a *status* is the one surface where a second
 * implementation of the pause overlay would stay invisible until the two disagreed. It is gone
 * rather than kept as a convenience: the RPC is the surface, and a second spelling of it is a
 * second answer waiting for a second caller.
 *
 * D1 stays authoritative; DO storage holds the library id, the alarm, the day's row-write count and
 * any pause. KV stays a non-load-bearing cache. That is what makes a DO restart safe: the frontier
 * lives in D1, so a lost isolate resumes rather than restarts.
 *
 * ### The exception to "DO storage holds the library id and the alarm", and why it is one
 *
 * A pause is the one piece of scan state that **cannot** be stored in D1, because it is usually
 * caused by D1 refusing writes: since 2026-09-01 an account over its daily row allowance has every
 * query fail until midnight UTC. The scan knows that is what happened, and there is nowhere in D1
 * to write it down — so it is written here, and `getStatus` reads it back, which is what lets the
 * operator's page say "paused until 00:00 UTC" instead of a 500 or an empty list.
 *
 * The day's row-write count is here for the same reason and one more: metering D1 writes must not
 * itself spend D1 writes.
 *
 * Nothing else moved. The frontier, every indexed row, the retry counter and the index version are
 * D1's, and a lost isolate still resumes rather than restarts.
 */
import { DurableObject } from 'cloudflare:workers';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { d1AllowancePause, pausedResult } from '@edge-sonic/backend-services/index';
import type { ChunkResult, ScanDailyBudget } from '@edge-sonic/backend-services/index';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { ScanPauseStore, isDailyLimitRefusal, SCAN_ALARM_DELAY_MS } from './scanPause';
import { chargeForIndexDrop, stopForIndexDrop } from './scanIndexDrop';
import { createScanWorkerScope } from './ScanWorkerFactory';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

const logger = createLogger('ScanWorker');

/**
 * The alarm the chain re-arms itself with after a fault it could not record.
 *
 * `SCAN_ALARM_DELAY_MS` and nothing else, and the reasoning is the point: a failure that
 * could not be written to `scan_state` has no `consecutive_failures` to bound it, so the
 * rate is what does the bounding. One attempt a second against a store that is refusing
 * writes is cheap, and it stops the instant the store recovers — which is the only moment
 * it should stop, because the alternative (`stalled`, and therefore no alarm) is a
 * permanent end to a scan over a transient fault.
 *
 * It is also why a pause does not use it: a pause's end is known and written down, so
 * re-arming a second later re-runs the whole failure path to reach the same conclusion
 * until midnight UTC. See `ScanPauseStore.arm`.
 */
const RETRY_ARM_DELAY_MS = SCAN_ALARM_DELAY_MS;

class ScanWorker extends DurableObject<Cloudflare.Env> {
  private readonly pause: ScanPauseStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.pause = new ScanPauseStore(ctx.storage);
  }

  private scope(): ReturnType<typeof createScanWorkerScope> {
    return createScanWorkerScope(this.env);
  }

  /**
   * Every registered library, which is also the divisor of the day's row-write budget.
   *
   * Returned **whole**, and that is not incidental: the count is what paces this object's chunk,
   * and D1 charges one statement per query, so reading the list once and using it for both the
   * divisor and the row is the difference between one statement and two on a path every chunk
   * takes.
   *
   * It is *not* how a caller resolves one library. `MediaWorker` needs exactly one row and uses
   * `LibraryService.findById`, because this reads every row — including each one's
   * `password_ciphertext` and `password_iv` — to find one by primary key. Two callers, two
   * shapes, and the reason is the count: this one needs the number.
   */
  private async libraries(): Promise<LibraryRow[]> {
    return await this.scope().get(Tokens.LibraryService).listAll();
  }

  /**
   * Every registered library, or `null` when D1 is refusing queries for a spent daily allowance.
   *
   * The first thing a spent allowance refuses is this read, so it is reached before any of the
   * scan's own logic. `null` rather than a throw, and the distinction is load-bearing: a thrown
   * refusal reaching `alarm`'s catch cannot be told from any other fault without re-classifying, so
   * it would re-arm at `RETRY_ARM_DELAY_MS` and the one-second loop would run for the hours until
   * the reset. Anything that is *not* a spent allowance still throws.
   */
  private async librariesOrPause(): Promise<LibraryRow[] | null> {
    try {
      return await this.libraries();
    } catch (error) {
      if (isDailyLimitRefusal(error)) return null;
      throw error;
    }
  }

  /**
   * Hold the pause in storage and arm the chain for its end.
   *
   * Shared by all three entry points that can reach a pause — the alarm, a manual step and the
   * operator's `startScan` — because "record it, then arm for it" is one operation and three copies
   * of it would be free to disagree about which comes first. Order matters: the pause is recorded
   * **before** the alarm is armed, so a crash between the two leaves an over-armed chain rather than
   * a paused scan with nothing scheduled to lift it.
   */
  private async pauseAndArm(pause: ChunkResult): Promise<ChunkResult> {
    await this.pause.record(pause);
    await this.pause.arm(pause);
    return pause;
  }

  /**
   * Stop this library's scan and forget its pause, without advancing the walk.
   *
   * The Danger Zone's index drop calls this **before** it deletes `songs`, `nodes` and
   * `scan_state`, and the ordering is the entire reason the RPC exists: a live alarm fires
   * every second, and one that fires between the two deletes walks the origin and writes the
   * index back. The reasoning — and why a held pause is cleared while the day's row count is
   * kept — is in `scanIndexDrop.ts`, beside the storage it touches rather than in this router.
   *
   * `libraryId` is accepted and ignored. One object per library means the id is always the one
   * this object already holds, and re-pointing it here would be a drop's job that `startScan`
   * already owns.
   */
  public async reset(libraryId: string): Promise<void> {
    void libraryId;
    await stopForIndexDrop(this.ctx, this.pause);
  }

  /**
   * Add billed rows to this object's count of today's D1 writes.
   *
   * The drop calls this **after** its deletes, with what they measured rather than with the
   * projection the operator confirmed against. `scanIndexDrop.ts` carries why the figure goes
   * through `ScanPauseStore`'s own accumulation instead of a second writer of the `memory` key.
   */
  public async charge(libraryId: string, billedRows: number): Promise<void> {
    void libraryId;
    await chargeForIndexDrop(this.pause, billedRows);
  }

  /**
   * Seed the frontier and schedule the alarm chain.
   *
   * Stores the library id so `alarm()` knows what to advance after a restart.
   */
  public async startScan(libraryId: string): Promise<ChunkResult> {
    // The library lookup is a D1 read, so it is refused first when the allowance is spent — before
    // any of the scan's own logic. Answering `paused` here is what makes the operator's Rescan button
    // report the pause and the hour it ends, instead of a masked 500 from the one surface whose job
    // is to explain what is wrong.
    const libraries = await this.librariesOrPause();
    if (libraries === null) return await this.pauseAndArm(await this.pause.pauseForRefusal());

    const library = libraries.find((candidate) => candidate.id === libraryId);
    if (library === undefined) throw new Error(`Unknown library "${libraryId}".`);
    // Unconditional, and it must be: `start` is what *seeds* the frontier and clears the
    // retry counter, so this is the one entry point that legitimately re-points the object
    // at a different library.
    await this.ctx.storage.put('libraryId', libraryId);
    const result = await this.scope()
      .get(Tokens.ScanService)
      .start(library, await this.pause.budget(libraries.length));
    await this.pause.arm(result);
    await this.pause.record(result);
    return result;
  }

  /**
   * Read-only status. Never advances the scan — that is what the alarm is for.
   *
   * Overlaid with this object's own pause, because the one status D1 cannot report is the status
   * whose cause is D1 refusing to answer. A `scan_state` read during a spent allowance throws, so the
   * honest alternative would be a 500 on the one call whose job is to say what is happening.
   *
   * The overlay is **only** ever applied to a pause this object is holding, and it is dropped the
   * moment a chunk runs, so it cannot report a condition that has ended. It is deliberately not used
   * to fill in any other field: the counters come from D1 when it answers and are zero when it does
   * not, because a fabricated `scanned` count on a page an operator reads as progress is the failure
   * this file has spent three separate fixes on.
   */
  public async getStatus(libraryId: string): Promise<ChunkResult> {
    const held = await this.pause.held();
    let stored: ChunkResult;
    try {
      stored = await this.scope().get(Tokens.ScanService).status(libraryId);
    } catch (error) {
      const fromError = d1AllowancePause(error, Date.now());
      if (fromError) return fromError;
      throw error;
    }
    // A held pause **overrides** the stored status rather than being reported beside it. D1 cannot
    // know about a pause entered *because* it was refusing writes, so its row is guaranteed stale
    // about it — it says `scanning`, which an operator reads as working and a client reads as
    // poll-me. D1 still fills the counts when it answers.
    return held === null ? stored : pausedResult(held.resumeAt, held.reason, stored.scanned);
  }

  /**
   * Advance one chunk, then re-arm the alarm while more work remains.
   *
   * The operator `POST .../scan/step` and `alarm()` share this: a manual step
   * is one chunk of the same loop, not a second implementation.
   *
   * ### There is no `dailyBudget` parameter here, and there was
   *
   * It was `dailyBudget?: () => ScanDailyBudget` — **a function on an RPC method**. Durable
   * Object RPC serializes its arguments, and a function is not serializable, so no caller could
   * ever have supplied one: `user/routes.ts` passes the library id and nothing else, and the
   * parameter was reachable from exactly one place in this repository, a test that called the
   * method in-process.
   *
   * So the signature advertised an injection point the platform does not have, and the test that
   * used it asserted a budget nothing in production could substitute — a double agreeing with the
   * broken caller rather than with the class. The budget is read from `ScanPauseStore`, which is
   * where production reads it from and the only store that can hold it; a test that needs a
   * spent allowance now seeds that storage, which is a measurement of the real path rather than
   * a second one.
   */
  public async stepOnce(libraryId: string): Promise<ChunkResult> {
    const libraries = await this.librariesOrPause();
    if (libraries === null) return await this.pauseAndArm(await this.pause.pauseForRefusal());

    const library = libraries.find((candidate) => candidate.id === libraryId);
    if (library === undefined) throw new Error(`Unknown library "${libraryId}".`);
    await this.rememberLibrary(libraryId);
    return await this.runChunk(library, await this.pause.budget(libraries.length));
  }

  public override async alarm(): Promise<void> {
    // Wrapped whole, because an alarm handler that rejects is a permanent wedge.
    //
    // It used to have no handler at all. Cloudflare retries a throwing alarm a bounded
    // number of times and then drops it, and every one of those retries was a chance for
    // the *same* fault to throw again — so the chain ended with D1 still recording
    // `scanning` and nothing scheduled to advance it. `getStatus` reports
    // `scanning: true` for ever, and every client reads that as *keep polling*, so the
    // symptom is a scan that looks alive and never moves. Nothing reconciled the two
    // stores: the alarm lives in DO storage, the status in D1, and `getAlarm()` is
    // called from nowhere in this repository.
    //
    // So the handler cannot reject, and a failure is recorded rather than discarded —
    // `willResumeWithoutAPoll('failed')` is true, so `arm` keeps the chain armed and
    // `consecutive_failures` bounds it. That is the difference between a bounded retry
    // and an unbounded one, and the reason the catch is here rather than around
    // `ScanService.step` alone: this is the code that owns the alarm, so this is where
    // re-arming is decided.
    try {
      const libraryId = await this.ctx.storage.get<string>('libraryId');
      if (!libraryId) return;
      const libraries = await this.librariesOrPause();
      if (libraries === null) {
        // Reached before the scan service is even called, because the library lookup is itself a D1
        // read. The old path re-armed one second later — ~86,400 times before the reset, each
        // attempt a failed read. The chain sleeps to the reset instead.
        await this.pauseAndArm(await this.pause.pauseForRefusal());
        return;
      }
      const library = libraries.find((candidate) => candidate.id === libraryId);
      if (library === undefined) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.runChunk(library, await this.pause.budget(libraries.length));
    } catch (error) {
      const pause = d1AllowancePause(error, Date.now());
      if (pause) {
        await this.pauseAndArm(pause);
        return;
      }
      logger.error('alarm failed; the chain stays armed for a bounded retry', error);
      // Re-arm unconditionally, and after the same delay a normal chunk would use. The
      // chunk's own failure already records `last_error` and counts against the retry
      // budget; this arm exists so a fault *outside* `step` — storage, the library lookup —
      // cannot silently end the chain. `RETRY_ARM_DELAY_MS` bounds the rate here, because
      // the counter that bounds the retries does not exist on this path.
      await this.ctx.storage.setAlarm(Date.now() + RETRY_ARM_DELAY_MS);
    }
  }

  /**
   * One chunk of the walk, with the alarm re-armed from its result.
   *
   * `stepOnce` and `alarm` share this because they are one loop: a manual step is a
   * chunk of the same walk, not a second implementation of it, and having them diverge
   * is how the two started disagreeing about whether a chunk was `idle`.
   */
  private async runChunk(library: LibraryRow, dailyBudget: () => ScanDailyBudget): Promise<ChunkResult> {
    const scope = this.scope();
    const result = await scope.get(Tokens.ScanService).step(library, dailyBudget);
    await this.pause.arm(result);
    await this.pause.record(result);
    return result;
  }

  /**
   * Persist the library this object scans, only when it has changed.
   *
   * `stepOnce` used to `put` it unconditionally on every call — one storage write per
   * operator step for a value that is almost always identical — while `alarm` correctly
   * read it. Reading first also removes a race: the write used to land between `alarm`'s
   * read and its `step`, so two interleaved entries could each proceed on the value they
   * happened to read.
   */
  private async rememberLibrary(libraryId: string): Promise<void> {
    const current = await this.ctx.storage.get<string>('libraryId');
    if (current !== libraryId) await this.ctx.storage.put('libraryId', libraryId);
  }
}

export { ScanWorker };
export { SCAN_ALARM_DELAY_MS } from './scanPause';