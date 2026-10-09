/**
 * What one scan chunk may spend, and what it spent.
 *
 * ### Why this counts more than WebDAV
 *
 * It used to count one thing: requests issued by `WebDavClient`. That was a real measurement —
 * `charge()` is wired to the client's private `request()`, the one path `propfind`, `get`,
 * `readPrefix` and `readTail` share — and it was the wrong measurement, because a subrequest is
 * not only a `fetch`. D1 states its own limit as *queries per Worker invocation — 50 (Free)*,
 * and a KV operation is a subrequest too.
 *
 * So a chunk of 40 folders charged this budget 40 and spent the platform about 240: 40
 * `PROPFIND`s, ~160 D1 statements for the frontier diff, the node and song upserts and the
 * prune, and ~40 KV reads and writes for the enrichment each folder did. It crossed the
 * ceiling mid-chunk, and the platform terminated the invocation — an error no `catch` in the
 * scan can see, so `ScanWorker.alarm` logged it, re-armed, and the next chunk died the same
 * way. A 110-track library "finished" only because each dead invocation left a little progress
 * behind, about twenty tracks at a time. See `docs/issues/free-plan-subrequest-ceiling.md`.
 *
 * ### Why the counter is borrowed rather than owned
 *
 * The meter belongs to the **request scope**, because that is the lifetime of an invocation
 * and because the DAOs and the KV cache hold a reference to it — they are constructed once per
 * scope and every statement they issue has to land in the same counter the chunk is reading. A
 * budget that constructed its own counter would be counting a second, private number while the
 * real one went unobserved, which is the defect all over again.
 *
 * So `ScanBudget` *wraps* the scope's counter: it resets it at the start of a chunk, adds the
 * wall-clock deadline the counter knows nothing about, and adds the per-unit reservations that
 * have to be made before the work rather than after it.
 */
import { NO_SUBREQUESTS_SPENT, subrequestSpend } from '@edge-sonic/shared';
import type { SubrequestCounter, SubrequestKind, SubrequestSpend } from '@edge-sonic/shared';

interface ScanBudgetOptions {
  /**
   * The invocation's counter.
   *
   * Reset on construction, so two chunks in one invocation — which is what the `POST
   * /user/libraries/:id/scan/step` route does when it seeds and then steps — do not share a
   * count, while still charging the *same* counter the DAOs and the KV cache write to.
   *
   * It is reset here rather than at construction of the scope because the counter's lifetime
   * is the invocation and the *chunk's* count starts at the beginning of a chunk. Two
   * different windows over one counter, which is only safe because nothing else reads it
   * between the reset and the end of the chunk.
   */
  meter: SubrequestCounter;
  /**
   * Subrequests this chunk may issue — the **inner** limit.
   *
   * Distinct from the counter's ceiling, which is the platform's and is not the chunk's to
   * spend: the chunk gets `ceiling − invocation reserve` so the rest of the invocation —
   * authentication, the library grant, `scan_state` — has room. Both are enforced, and
   * `canAfford` requires both, so a chunk cannot spend the reserve even if every one of its
   * own bounds is satisfied.
   */
  maxRequests: number;
  /**
   * Milliseconds this chunk may take.
   *
   * A deadline is checked between units of work, so a chunk overruns by at most one in-flight
   * request — bounded by the per-request timeout, not by this.
   */
  deadlineMs: number;
  /**
   * Clock, injectable so the deadline is testable without fake timers.
   */
  now?: () => number;
}

class ScanBudget {
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(private readonly options: ScanBudgetOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.options.meter.reset();
    // The chunk's ceiling on the meter, so the charge points below this layer enforce it too.
    // `canAfford` below was the only thing that knew it, and the write batch was not one of
    // those things: `BaseDAO.fitCount` read `meter.remaining`, so a batch could issue up to the
    // platform's 50 while this budget said 42 — spending the invocation's reserve, after which
    // `saveProgress` crosses the ceiling and the runtime terminates the invocation.
    this.options.meter.setCeiling(options.maxRequests);
  }

  /**
  Subrequests issued so far, of every kind.
  */
  public get spent(): number {
    return this.options.meter.spent;
  }

  /**
   * How many more subrequests fit, under **both** ceilings, floored at zero.
   *
   * The minimum rather than the chunk's own arithmetic alone: the platform's ceiling is the
   * one that kills the invocation, so a chunk that believes it has room when it does not is
   * the failure this file exists to prevent, and the reverse — believing it has none when it
   * does — only costs a poll.
   */
  public get remaining(): number {
    return Math.min(this.options.meter.remaining, Math.max(0, this.options.maxRequests - this.options.meter.spent));
  }

  /**
  The ceiling this chunk runs under.
  */
  public get ceiling(): number {
    return this.options.maxRequests;
  }

  /**
  Milliseconds left before the deadline, floored at zero.
  */
  public get remainingMs(): number {
    return Math.max(0, this.options.deadlineMs - (this.now() - this.startedAt));
  }

  /**
  Whether the chunk must stop taking on work.
  */
  public get exhausted(): boolean {
    return this.options.meter.spent >= this.options.maxRequests || this.options.meter.exhausted || this.remainingMs <= 0;
  }

  /**
   * Whether `count` more subrequests would still fit.
   *
   * `n` is the *worst case* for the unit about to run, and that is the whole discipline: the
   * charge happens after the work is issued, because a charge point cannot know in advance how
   * many statements a folder's upsert turns into, so the decision has to be made with a
   * reservation. Admitting a unit on the cost of the requests it *might* make is how a budget
   * gets spent past its ceiling.
   */
  public canAfford(count = 1): boolean {
    if (this.remainingMs <= 0) return false;
    return this.options.meter.canAfford(count) && this.options.meter.spent + count <= this.options.maxRequests;
  }

  /**
   * Record `count` subrequests issued.
   *
   * Wired to `WebDavClient`'s `onRequest`, so this is called by the client rather than by the
   * loop that decided to call the client. D1 and KV do not come through here — they charge the
   * same counter from inside the DAO and the cache — which is why the budget and the counter
   * are one object rather than two that have to be kept in step.
   */
  public charge(count = 1, kind: SubrequestKind = 'fetch'): void {
    this.options.meter.charge(count, kind);
  }

  /**
   * What this chunk spent, per kind.
   *
   * Reported rather than kept private because an operator whose scan keeps pausing at the
   * ceiling needs to know *which* resource ran out, and `stoppedBy: 'requests'` alone cannot
   * tell them.
   */
  public spend(): SubrequestSpend {
    return this.options.meter.spent === 0
      ? NO_SUBREQUESTS_SPENT
      : subrequestSpend(this.options.meter.breakdown(), this.options.meter.spent);
  }
}

/**
 * Which bound ended a chunk.
 *
 * `frontier` is the ordinary case — the chunk ran out of folders to visit.
 * The other two say the work was cut short by a limit, which is what an operator
 * looking at a scan that is not finishing needs to be told. `null` is a chunk that
 * did no work at all: no scan running, or a library that has not been configured.
 */
type ChunkStopReason = 'frontier' | 'requests' | 'deadline' | null;

/**
 * Name the bound that ended a chunk, or `frontier` when none did.
 *
 * Both exhausted states are reported rather than collapsed into one value: a
 * chunk stopped at the subrequest ceiling and a chunk stopped at 20 s have
 * different remedies, and "it stopped" is not a diagnosis.
 *
 * `requests` is now a state a Free-plan deployment reaches **by design** rather than by
 * misconfiguration — it is what a 42-subrequest chunk looks like on a 110-track library — so it
 * is a normal return with the alarm re-armed behind it, not a failure that spends the retry
 * budget. Before the ceiling was measured, the same condition killed the invocation instead,
 * which is why a scan that could never finish looked like a scan that kept failing.
 */
function stopReason(budget: ScanBudget, exhaustedWork: boolean): ChunkStopReason {
  if (!exhaustedWork) return 'frontier';
  // Time first, then the ceiling — not the other way round. `remaining > 0` does not mean the
  // chunk could have done anything: it may have had five subrequests left and needed six for
  // the next folder, which is the **request** ceiling stopping it and not a clock. Asking
  // `remaining <= 0` made exactly that case report `deadline`, so an operator was told a slow
  // origin had ended the chunk when a number had.
  if (budget.remainingMs <= 0) return 'deadline';
  return 'requests';
}

export { ScanBudget, stopReason };
export type { ScanBudgetOptions, ChunkStopReason };
