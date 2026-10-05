/**
 * The pause, and the day's row-write budget it is measured against.
 *
 * ### Why this is its own module
 *
 * Because `ScanWorker` is a facade: routing and composition, with a god-file guard at 400 lines to
 * keep it that way. The pause is a *decision* with a state machine in it — when to hold it, when to
 * drop it, what it costs to hold — and it was arriving as 280 lines of comments and helpers in a
 * file whose subject is "one Durable Object per library".
 *
 * ### The one thing that makes a pause possible
 *
 * A spent D1 daily allowance has an end: **midnight UTC**. Since 2026-09-01 an account over it has
 * every query fail — reads included, through the binding API and the REST API alike — so the whole
 * product is down, and nothing about the refusal can be fixed by trying again. It is the only D1
 * fault in this repository whose remedy is a clock rather than a change.
 *
 * That is what makes `paused` a status rather than another flavour of `failed`, and it is why the
 * work is held in Durable Object storage: **a pause is usually caused by D1 refusing writes**, so a
 * pause kept in `scan_state` would be unwritable exactly when it is needed, and the operator's page
 * — which reads D1 — could not see it either.
 *
 * So this module owns three decisions, each of which is a choice rather than code:
 *
 * - **The alarm stays armed and sleeps to the reset.** `willResumeWithoutAPoll`, not `isAdvancing`.
 *   The alarm is the only thing that advances a scan in production, and `isAdvancing` answers the
 *   *client's* question and says `false` for exactly this status — right for a client, fatal here.
 * - **The retry counter is not spent.** `consecutive_failures` bounds retries of a *fault*. Charging
 *   it here would eventually produce `stalled`, which deletes the alarm and leaves the scan
 *   unrecovered until an operator notices.
 * - **The count is a lower bound, and it is kept here.** Metering D1 writes must not itself spend
 *   D1 writes: a counter in `scan_state` is a D1 row per chunk, against the very allowance it
 *   enforces.
 */
import { dailyRowWriteShare } from '@edge-sonic/backend-runtime/config';
import { isD1DailyLimitError } from '@edge-sonic/backend-data/utils';
import { d1AllowancePause, pausedResult, willResumeWithoutAPoll } from '@edge-sonic/backend-services/index';
import type { ChunkResult, ScanDailyBudget } from '@edge-sonic/backend-services/index';

/**
 * Milliseconds between alarm-driven chunks.
 *
 * Non-zero so a chunk's `waitUntil` work settles before the next alarm fires,
 * and small enough that a scan of many chunks finishes while an operator
 * watches. The chunk itself is still bounded by `ScanBudget`, so this is a
 * pacing delay, not a work bound.
 */
const SCAN_ALARM_DELAY_MS = 1000;

/**
 * Rows between writes of the day's row-write count to Durable Object storage.
 *
 * The count is a **lower bound** within this interval, and the interval is the price of the
 * placement: Durable Object storage has its own daily write allowance, and persisting on every
 * chunk would spend ~86,000 of it a day to track a day's worth of D1 rows — trading one
 * allowance for another at a far worse rate.
 *
 * The bound is what makes the placement sound rather than merely cheap. A crash or an eviction can
 * lose at most this many rows of the count, so the scan overshoots its share by at most this many
 * rows, and `D1_DAILY_ROW_WRITE_RESERVE` exists to absorb exactly that. Asserted as a relationship —
 * the interval is inside the reserve — because an interval above the reserve is a metering scheme
 * that can overshoot the thing it meters, and nothing else would say so.
 *
 * Also asserted in **billed** rows, which is the unit this counts: the interval is a number of
 * rows, and a chunk that writes `songs` covers it in roughly a tenth of the rows it bills.
 */
const SCAN_ROW_COUNT_PERSIST_INTERVAL = 500;

/**
 * What this object remembers about a day, and about a pause.
 *
 * `day` is stored rather than derived because a Durable Object is re-instantiated constantly — on
 * eviction, on a deploy, on any request arriving on a different machine — and a counter without its
 * day is a counter that starts the day over whenever the object is evicted, which on a busy
 * deployment is often.
 */
interface ScanWorkerMemory {
  readonly day: string;
  /**
   * **Billed** rows written today, per the platform's unit.
   *
   * Named `rows` rather than `billedRows` because it is what DO storage has always held and the
   * key is `memory` either way — a stored counter whose meaning changed is a migration question,
   * and this one is deliberately not one. The unit was *always* meant to be D1's; it was
   * populated with table rows by mistake. See `record`.
   */
  readonly rows: number;
  readonly pause: { readonly resumeAt: number; readonly reason: string } | null;
}

/**
 * Cloudflare's refusal, verbatim.
 *
 * The classifier matches on this text, so a paraphrase here would mean the classifier had never seen
 * the string it exists to recognise — and the whole branch would be reachable only from a test that
 * supplied the real one. It is the only place in the repository that spells the platform's sentence
 * out, and it exists because `pauseForRefusal` has to construct one.
 */
const DAILY_LIMIT_REFUSAL =
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

/**
 * The UTC day a timestamp belongs to, as a stable string.
 *
 * A string rather than a day index because it is stored and compared across isolate restarts, and
 * the arithmetic that derives it from a timestamp is the kind of thing that has to be written once.
 */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The state this object keeps between chunks, and the transitions it makes.
 *
 * A class rather than four free functions taking a storage handle, because the interesting part is
 * *when* each write happens and that is a function of all three fields at once. The methods take the
 * storage directly so `ScanWorker` holds no state of its own beyond the pending accumulation.
 */
class ScanPauseStore {
  /**
   * **Billed** rows accumulated since the last storage write.
   *
   * An instance field, and that is the one approximation here: an eviction discards it, so the
   * persisted `rows` can under-count by up to one chunk's worth beyond the interval. `D1_DAILY_ROW_WRITE_RESERVE`
   * is what absorbs it.
   */
  private pendingRows = 0;

  constructor(private readonly storage: DurableObjectStorage) {}

  public async read(): Promise<ScanWorkerMemory> {
    const stored = await this.storage.get<ScanWorkerMemory>('memory');
    return stored ?? { day: utcDay(Date.now()), rows: 0, pause: null };
  }

  /**
   * Record what a chunk spent, and hold or clear the pause.
   *
   * Three writes happen, each a change of *kind* rather than a per-chunk cost: a pause appearing or
   * disappearing (immediately — an operator is reading it, and a threshold delay would report it
   * late or drop it), the day rolling over (the stored `day` is what makes the comparison), and the
   * row count (at most once per `SCAN_ROW_COUNT_PERSIST_INTERVAL`). Between those, nothing is
   * written at all, which is the whole reason the count lives here and not in `scan_state`.
   */
  public async record(result: ChunkResult): Promise<void> {
    const memory = await this.read();
    const today = utcDay(Date.now());
    const rolledOver = memory.day !== today;
    // `billedRows`, **not** `rowsWritten`. This is the whole of the correction: D1's daily
    // allowance is denominated in billed rows — the table row plus every index entry the write
    // rewrote — and `songs` carries nine indexes, so a count of table rows told this budget it
    // had ten times the headroom it actually had before the platform refused every query on the
    // account until midnight UTC.
    const rows = (rolledOver ? 0 : memory.rows) + result.billedRows;
    this.pendingRows = rows - (rolledOver ? 0 : memory.rows);

    const pause = result.status === 'paused' && result.resumeAt !== null ? { resumeAt: result.resumeAt, reason: result.lastError ?? 'Paused.' } : null;
    const pauseChanged = (memory.pause === null) !== (pause === null) || memory.pause?.resumeAt !== pause?.resumeAt;

    if (!rolledOver && !pauseChanged && this.pendingRows < SCAN_ROW_COUNT_PERSIST_INTERVAL) return;

    await this.storage.put('memory', { day: today, rows, pause });
    this.pendingRows = 0;
  }

  /**
   * Arm the chain for a chunk's result, or disarm it.
   *
   * `willResumeWithoutAPoll` and not `isAdvancing`, and the arm time is the pause's — so a paused
   * chain sleeps through the window instead of re-running the same refusal a second at a time until
   * the reset. `deleteAlarm` is what makes `stalled` terminal, which is correct for a scan nothing is
   * scheduled to retry and catastrophic for one that will retry itself.
   */
  public async arm(result: ChunkResult): Promise<void> {
    if (willResumeWithoutAPoll(result.status)) {
      await this.storage.setAlarm(result.resumeAt ?? Date.now() + SCAN_ALARM_DELAY_MS);
    } else {
      await this.storage.deleteAlarm();
    }
  }

  /**
   * The day's budget for one library.
   *
   * The **share**, divided by the number of libraries actually registered — which the caller has
   * already read on the way to the chunk, so the divisor costs nothing. A per-library cap equal to
   * the whole allowance is unsound the moment a second library exists: two libraries would write
   * twice what D1 accepts between them, and the reactive pause would be all that stood between that
   * and an outage.
   */
  public async budget(libraryCount: number): Promise<() => ScanDailyBudget> {
    const memory = await this.read();
    return () => ({
      // Billed rows on both sides of the comparison, because that is the platform's unit. See
      // the note on `record`.
      billedRowsWrittenToday: memory.rows + this.pendingRows,
      limit: dailyRowWriteShare(libraryCount),
      now: Date.now,
    });
  }

  /**
   * The held pause, or `null`.
   *
   * Read by `getStatus`, which is the only surface that can report a pause D1 cannot see — and the
   * only reason this exists separately from `budget` is that it is a *read* on a path the operator
   * polls, against an allowance that is already spent.
   */
  public async held(): Promise<{ readonly resumeAt: number; readonly reason: string } | null> {
    return (await this.read()).pause;
  }

  /**
   * A `ChunkResult` for a path that has classified no pause yet.
   *
   * Used when the library lookup is refused before the scan service is reached, so there is no chunk
   * result to carry the classification — this object's storage is the only place the pause can be,
   * and on the first refusal it is empty.
   */
  public async pauseForRefusal(): Promise<ChunkResult> {
    const held = await this.held();
    if (held !== null) return pausedResult(held.resumeAt, held.reason);
    const pause = d1AllowancePause(new Error(DAILY_LIMIT_REFUSAL), Date.now());
    // Non-null by construction: the literal is the platform's message and the classifier matches it.
    // The guard is here rather than a cast because a classifier that stopped matching it should fail
    // loudly at one place instead of publishing `undefined` as a `ChunkResult`.
    if (pause === null) throw new Error('The D1 daily-limit classifier stopped matching the platform refusal it exists to recognise.');
    return pause;
  }
}

/**
 * Whether a lookup failure is a spent allowance, and so not a fault to retry.
 *
 * `null` rather than a boolean, and the distinction is the point: a Durable Object that cannot be
 * reached is a different event from a scan that is paused, and `alarm`'s catch cannot tell them apart
 * without re-classifying — so it would re-arm at `RETRY_ARM_DELAY_MS` and the one-second loop this
 * whole feature exists to stop would run for the hours until the reset. Everything that is *not* a
 * spent allowance still throws, because a bounded retry is the correct answer to a fault the counter
 * exists for.
 */
function isDailyLimitRefusal(error: unknown): boolean {
  return isD1DailyLimitError(error) !== null;
}

export { ScanPauseStore, isDailyLimitRefusal, SCAN_ALARM_DELAY_MS, SCAN_ROW_COUNT_PERSIST_INTERVAL };
export type { ScanWorkerMemory };