/**
 * What one scan chunk is allowed to spend.
 *
 * ### Why a chunk needs a budget at all
 *
 * A chunk used to be "however many folders `SCAN_CHUNK_FOLDERS` names", walked
 * sequentially with nothing checked. On an origin answering a ranged `GET` in
 * 2.2 s, 40 folders is 88 seconds of wall clock and the client gives up long
 * before that — so the work still completed server-side, invisibly, and a client
 * that backed off stopped advancing the scan by construction. Adding enrichment
 * made it worse: per-track range reads moved *inside* the same sequential loop,
 * taking a chunk from 40 subrequests to 1,640.
 *
 * Two independent bounds, because they defend against two different failures:
 *
 * - **A request ceiling.** The platform counts subrequests per invocation, and a
 *   chunk that exceeds it does not complete slowly, it **fails**. Free plan is 50
 *   external subrequests (Paid is 10,000; the 1,000 figure this was originally
 *   sized against was retired on 2026-02-11), so a chunk bounded at 40 leaves
 *   headroom for redirect chains, which the platform also counts.
 * - **A wall-clock deadline.** A fast origin and a slow one differ by two orders
 *   of magnitude per request, and neither a folder count nor a request count is
 *   right for both. The deadline is what makes a poll *return* on a 2 s origin.
 *
 * ### Why the count is measured rather than asserted
 *
 * `charge()` is called by `WebDavClient.request()` — the single choke point every
 * WebDAV call funnels through — so this is a measurement of what was issued and
 * not a claim about what was attempted. A caller-incremented counter under-reports
 * by construction, which is exactly the defect that made the old
 * `webdavRequests` field useless as a budget.
 *
 * ### Why the loop leaves rather than finishes
 *
 * Exceeding a bound mid-chunk is not a failure. The frontier lives in D1 as
 * `is_scanned = 0` rows, so a folder this chunk did not open is still there for
 * the next poll. What does not fit keeps `enriched_at = null` and is enriched on
 * first play — a track with no duration until someone opens it, rather than a
 * chunk that fails.
 */
interface ScanBudgetOptions {
  /**
   * Subrequests this chunk may issue.
   *
   * Sized against the platform's **external** subrequest ceiling, not against the
   * 1,000 figure that predates 2026-02-11: Free plan allows 50 per invocation.
   */
  maxRequests: number;
  /**
   * Milliseconds this chunk may take.
   *
   * A deadline is checked between units of work, so a chunk overruns by at most
   * one in-flight request — bounded by the per-request timeout, not by this.
   */
  deadlineMs: number;
  /**
   * Clock, injectable so the deadline is testable without fake timers.
   */
  now?: () => number;
}

class ScanBudget {
  private spentRequests = 0;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(private readonly options: ScanBudgetOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /**
   * Subrequests issued so far.
   *
   * The value reported as `ChunkResult.webdavRequests`, and the one a test
   * asserts against what its WebDAV double actually received.
   */
  public get spent(): number {
    return this.spentRequests;
  }

  /**
   * How many more subrequests fit under the ceiling.
   */
  public get remaining(): number {
    return Math.max(0, this.options.maxRequests - this.spentRequests);
  }

  /**
   * Milliseconds left before the deadline, floored at zero.
   */
  public get remainingMs(): number {
    return Math.max(0, this.options.deadlineMs - (this.now() - this.startedAt));
  }

  /**
   * Whether the chunk must stop taking on work.
   *
   * Checked **before** a unit of work starts rather than after it finishes, so
   * the answer is a decision and not a report.
   */
  public get exhausted(): boolean {
    return this.spentRequests >= this.options.maxRequests || this.remainingMs <= 0;
  }

  /**
   * Whether `count` more subrequests would still fit.
   *
   * `n` is the *worst case* for the unit about to run: an enriched Ogg track
   * costs a prefix read and a tail read, and admitting it on the cost of one is
   * how a budget gets spent past its ceiling.
   */
  public canAfford(count = 1): boolean {
    return !this.exhausted && this.spentRequests + count <= this.options.maxRequests && this.remainingMs > 0;
  }

  /**
   * Record `count` subrequests issued.
   *
   * Wired to `WebDavClient`'s `onRequest`, so this is called by the client rather
   * than by the loop that decided to call the client.
   */
  public charge(count = 1): void {
    this.spentRequests += count;
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
 * chunk stopped at 40 requests and a chunk stopped at 20 s have different
 * remedies, and "it stopped" is not a diagnosis.
 */
function stopReason(budget: ScanBudget, exhaustedWork: boolean): ChunkStopReason {
  if (!exhaustedWork) return 'frontier';
  if (budget.remaining <= 0) return 'requests';
  return 'deadline';
}

export { ScanBudget, stopReason };
export type { ScanBudgetOptions, ChunkStopReason };
