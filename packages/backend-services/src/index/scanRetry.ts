/**
 * Deciding whether a scan may run another chunk, and what to tell a client when it may
 * not.
 *
 * ### Why this is its own module
 *
 * `step` used to answer two questions inline — *may this poll do work?* and *what does a
 * poll report?* — and the second one is what clients read. The first is a state machine
 * over `scan_state`; the second is a mapping onto a protocol element that carries only
 * `scanning` and `count`. They are separate decisions, they were tangled, and the tangle
 * is what shipped.
 *
 * ### The defect
 *
 * `step` short-circuited on any status other than `scanning`, and `fail` sets `failed`.
 * So a single bad chunk made a scan **terminal**: the next poll read the stored failure
 * and did no work, and neither did the one after that. The frontier was still in D1,
 * complete and intact, and nothing would ever read it again — a library of eighty albums
 * stayed at one scanned folder for the life of the deployment.
 *
 * The module header claimed the opposite ("a failure leaves the frontier where it was, so
 * the next poll resumes rather than restarting") and the claim was true of the frontier
 * and false of the code that read it. Only `startScan` recovered, and `startScan` runs at
 * client startup, not while somebody browses.
 *
 * It was invisible because `getScanStatus` derived `scanning` from the status, so
 * `failed` and a completed scan serialized identically as `scanning: false` — which every
 * client reads as *stop polling*. The reason was in `scan_state.last_error` the whole time,
 * reachable only from `/user/*` behind Cloudflare Access.
 *
 * ### Why the retry is bounded
 *
 * Because unbounded is the opposite defect. A permanently broken library re-attempted on
 * every poll for ever spends the operator's WebDAV requests to reach the same conclusion
 * each time. A *transient* fault — an origin that 500s once — must not end a scan, so the
 * bound cannot be one. `MAX_CONSECUTIVE_FAILURES` separates the two, is persisted so it
 * survives the isolate, and is cleared by `startScan`, which is the operator's escape
 * hatch and needs no surface of its own.
 */
import { isD1DailyLimitError, nextMidnightUtc } from '@edge-sonic/backend-data/utils';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import { LAST_ERROR_MAX, MAX_CONSECUTIVE_FAILURES } from './scanTypes';
import type { ChunkResult, ScanDailyBudget, ScanStatus } from './scanTypes';
import type { ScanStateRow } from '@edge-sonic/backend-data/dao';

/**
 * What a poll may do, given the stored state.
 *
 * `'run'` and `'stalled'` are the decisions `step` branches on. `'idle'` is separated
 * from `'stalled'` because they are opposites in what they tell a client: one means
 * "nothing is happening and nothing is wrong", the other means "something is wrong and
 * retrying has stopped helping".
 *
 * `'paused'` is a fourth, and it is not derived from the row at all — a pause is never
 * persisted, because the fault that causes it is a refusal to write. It is decided by
 * `dailyWriteAllowanceSpent` and by the error itself, and it comes *before* this
 * decision, because a scan that may not write must not first read its own state to find
 * that out: on a D1 that is refusing every query, that read is the failure.
 */
type StepDecision = 'run' | 'idle' | 'stalled';

/**
 * Whether this poll may advance the scan.
 *
 * A `failed` scan is **run**, not refused. That single word is the whole fix, and it is
 * why the `failed` case is tested separately from `idle`: collapsing the two is what made
 * a transient origin failure permanent.
 */
function decideStep(state: ScanStateRow): StepDecision {
  if (state.status === 'failed') {
    return state.consecutive_failures >= MAX_CONSECUTIVE_FAILURES ? 'stalled' : 'run';
  }
  return state.status === 'scanning' ? 'run' : 'idle';
}

/**
 * Whether the day's row-write allowance is spent, and so this chunk must not issue a write.
 *
 * Checked **before** the walk rather than after it, and that placement is the mechanism rather
 * than a detail: a check after the walk bounds nothing, because by then the rows are written and
 * the allowance is spent. Checked before, a scan over its allowance costs one chunk's *reading*
 * and no rows at all, and then nothing at all until the day rolls over.
 *
 * `>=` and not `>` because the allowance is a ceiling: a chunk that would take the count to
 * exactly `limit` has spent it, and the chunk after it is the one that must not start.
 */
function dailyWriteAllowanceSpent(budget: ScanDailyBudget | undefined): boolean {
  return budget !== undefined && budget.limit > 0 && budget.rowsWrittenToday >= budget.limit;
}

/**
 * The pause a **spent daily share** implies, or `null` when this chunk may write.
 *
 * Separate from `d1AllowancePause` because the two are different events with the same remedy: this
 * one is decided *before* the walk from a count the caller keeps, and it is the reason a scan never
 * reaches the state the other one recovers from. A correct chunk writes ~42 rows at ~1/second, so
 * 5,000 rows/day is roughly two minutes of scanning — the platform's limit is reached by design, and
 * a fix that only made the outage survivable would leave it frequent.
 *
 * `null` rather than a boolean so a caller cannot forget the reset time, and `now` is read from the
 * budget rather than from `Date.now()` so the boundary is testable.
 */
function dailyAllowancePause(budget: ScanDailyBudget | undefined): ChunkResult | null {
  if (!dailyWriteAllowanceSpent(budget) || budget === undefined) return null;
  return pausedResult(
    nextMidnightUtc(budget.now()),
    `This library has written its ${budget.limit}-row share of today's D1 row-write allowance. The scan resumes itself at 00:00 UTC.`,
  );
}

/**
 * A chunk that will not run until `resumeAt`, reported without touching the network.
 *
 * `scanned` and `total` come from whatever the caller had, which on the D1-refusal path is a
 * **zero-valued placeholder**: `scan_state` cannot be read either, so there is nothing to report
 * and a fabricated count would be a claim about a library this call never looked at. The reason
 * is the whole content of the answer, which is why it is a constructor rather than a status code
 * a client has to be told the meaning of.
 *
 * Every counter is zero because nothing was measured. `lastError` is the sentence an operator
 * needs, and it names the time the work resumes rather than asking them to work it out.
 */
function pausedResult(resumeAt: number, lastError: string, scanned = 0, total = 0): ChunkResult {
  return {
    status: 'paused',
    scanned,
    total,
    indexVersion: 0,
    lastError,
    foldersVisited: 0,
    subrequests: NO_SUBREQUESTS_SPENT,
    rowsWritten: 0,
    stoppedBy: null,
    resumeAt,
  };
}

/**
 * The pause a spent **D1 allowance** implies, or `null` for any other fault.
 *
 * `null` rather than a boolean because the caller needs the reset time, and a boolean would
 * send every call site to recompute it — the second answer to one question that this repository
 * keeps paying for. The reset is `nextMidnightUtc`, because that is when D1 restores service, and
 * it is read from the same clock the caller injects rather than from `Date.now()` so that the
 * boundary is testable at all.
 *
 * ### Why this is checked before anything is written
 *
 * Because the fault *is* a refusal to write. Recording it costs a statement that cannot succeed,
 * so the old path — catch, `scanState.fail`, `failed`, re-arm in a second — spent a failed
 * statement per alarm to reach a conclusion that changed nothing, and spent the retry counter on
 * a condition the counter was never meant to bound.
 */
function d1AllowancePause(error: unknown, nowMs: number): ChunkResult | null {
  const limit = isD1DailyLimitError(error, nowMs);
  if (!limit) return null;
  return pausedResult(
    limit.resetsAt,
    limit.kind === 'write'
      ? 'The daily D1 row-write allowance is used up. D1 refuses every query until 00:00 UTC, so the scan resumes itself then.'
      : 'The daily D1 row-read allowance is used up. D1 refuses every query until 00:00 UTC, so the scan resumes itself then.',
  );
}

/**
 * A poll that will do no work, reported from stored state.
 *
 * `foldersVisited`, `subrequests` and `rowsWritten` are all zero because they are
 * **measured**, not defaulted: this call issued no request and wrote no row, and a
 * non-zero number here would be a claim the service cannot support — except for
 * `rowsWritten`, which the caller may have written to, by the derivation backfill, before
 * the status check decided the walk had nothing to do. `lastError` is carried so the
 * reason a scan is incomplete survives a poll that touched nothing — the operator API is
 * the only surface that can show it, and this is where it comes from.
 */
function idleResult(state: ScanStateRow, status: 'idle' | 'failed' | 'stalled', rowsWritten = 0): ChunkResult {
  return {
    status,
    scanned: state.scanned_count,
    total: state.total_count,
    indexVersion: state.index_version,
    // `null` only for a genuinely idle scan: an `idle` row's `last_error` is already
    // NULL, and a scan nobody is asking about is not the place to explain itself.
    lastError: status === 'idle' ? null : state.last_error,
    foldersVisited: 0,
    subrequests: NO_SUBREQUESTS_SPENT,
    rowsWritten,
    stoppedBy: null,
    resumeAt: null,
  };
}

/**
 * A failed scan whose retry budget is spent, reported without touching the network.
 *
 * Reached from `step` before any `PROPFIND`, which is the point: the bound exists so a
 * permanently broken library is not re-attempted, and a check that ran *after* the first
 * request would already have spent one.
 */
function stalledResult(state: ScanStateRow, rowsWritten = 0): ChunkResult {
  return idleResult(state, 'stalled', rowsWritten);
}

/**
 * A failed scan with nothing left to retry, having recorded one more failure.
 *
 * A poll that made no progress must still spend the budget, or a scan whose *root probe*
 * keeps failing retries for ever — reporting progress and doing nothing, because an empty
 * frontier costs zero requests and would never exhaust a counter raised only on work.
 *
 * The stored reason is re-recorded rather than a new one invented: the cause has not
 * changed, and there is nothing to retry until `startScan` reseeds the frontier.
 */
async function unableToAdvance(state: ScanStateRow, fail: (error: string) => Promise<number>, rowsWritten = 0): Promise<ChunkResult> {
  const message = state.last_error ?? 'The library root could not be read, so the scan has no folder to start from.';
  const consecutiveFailures = await fail(message);
  return idleResult(state, consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'stalled' : 'failed', rowsWritten);
}

/**
 * What `getScanStatus` reports as `scanning`: **will more work happen if I poll again?**
 *
 * Not "did this call do work". Answering the latter made a retried scan report
 * `scanning: false`, every client read that as *stop polling*, and the client stopped —
 * so the frontier in D1 was never read again.
 *
 * `failed` is therefore `true`: it will be retried, within its bound. `stalled` is
 * `false`, and that is the only state where it is right to stop.
 *
 * A **read-only** status (`ScanService.status`, the operator surface) reports `stalled`
 * from the stored counter, so an operator opening the page sees the same terminal state a
 * poll would have reported rather than a `failed` that reads as "retrying" when it is not.
 */
function isAdvancing(status: ScanStatus): boolean {
  return status === 'scanning' || status === 'failed';
}

/**
 * Whether the scan will make progress **without a client doing anything**.
 *
 * The second question, and the one `ScanWorker` needs — because its alarm is the only thing that
 * advances a scan in production, and an alarm deleted here is a scan that never resumes.
 *
 * It exists because `isAdvancing` could not answer both questions at once. A `paused` scan is
 * `true` here — the alarm must stay armed, or nothing re-arms it when the allowance resets —
 * and `false` there, because a Subsonic client reading `scanning: true` polls, and for a paused
 * scan polling buys *nothing*: the next chunk cannot run before a wall-clock moment arrives, and
 * no amount of asking moves that moment. One predicate for both is the same shape of defect as
 * `scanning` answering "did this call do work", which is what stopped every scan in the product
 * from ever finishing.
 *
 * So `paused` is not `isAdvancing` either way, and both halves are asserted: `getScanStatus`
 * answering `scanning: true` for a scan that cannot run would send a client round the loop for
 * hours, and the alarm being deleted would leave an allowance spent until an operator noticed.
 */
function willResumeWithoutAPoll(status: ScanStatus): boolean {
  return status === 'scanning' || status === 'failed' || status === 'paused';
}

/**
 * The reported status of a stored row, without touching the network.
 *
 * ### Why this is a function and not an expression at the call site
 *
 * `failed` and `stalled` are the **same** stored status — both are written as `'failed'` by
 * `ScanStateDAO.fail` — and they are distinguished only by the retry counter beside them.
 * So "read the row and report its status" is not a field copy; it is a decision, and the
 * decision is the one thing two readers must not make differently.
 *
 * It was inlined in `ScanService.status`, which meant the operator's library list had no
 * honest way to report a terminal scan: it would either have had to re-derive the mapping —
 * a second answer to the same question, free to disagree — or report `failed` and read as
 * "still retrying" for a scan that will never be retried. That is the same failure
 * `isAdvancing` records, one layer along: a state that reads as "keep going" where the
 * answer is "this needs the operator".
 */
function storedStatus(state: ScanStateRow): ScanStatus {
  if (state.status === 'scanning') return 'scanning';
  if (state.status === 'failed') return state.consecutive_failures >= MAX_CONSECUTIVE_FAILURES ? 'stalled' : 'failed';
  return 'idle';
}

export {
  decideStep,
  dailyAllowancePause,
  dailyWriteAllowanceSpent,
  d1AllowancePause,
  pausedResult,
  idleResult,
  stalledResult,
  unableToAdvance,
  isAdvancing,
  willResumeWithoutAPoll,
  storedStatus,
  describeFailure,
  unrecordedFailure,
};
export { MAX_CONSECUTIVE_FAILURES } from './scanTypes';
export type { StepDecision };

/**
 * A failure's text, bounded to what the store will hold.
 *
 * Lives here because recording a failure is what this module owns — `step` and
 * `failChunk` both call it, and they did not agree to before: a diagnosis that depends on
 * which frame caught the error is not a diagnosis.
 */
function describeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX);
}

/**
 * A `ChunkResult` for a failure that happened before any state could be read.
 *
 * Counts are zero because nothing was measured, not because nothing happened. The
 * `lastError` is what an operator reads, and reporting fabricated counters beside a real
 * reason is worse than reporting none — `total: 0` with `status: 'failed'` says "the walk
 * could not start", which is exactly what happened, where `total: 412` would be a claim
 * about a library this call never looked at.
 *
 * `status` is `failed`, never `stalled`, and the caller must not promote it: `isAdvancing`
 * is false for `stalled`, so a terminal answer here would delete the alarm and end the
 * scan over a fault that may be transient. The retry counter cannot be incremented on this
 * path, so the *delay* between retries is what bounds it.
 */
function unrecordedFailure(lastError: string): ChunkResult {
  return {
    status: 'failed',
    scanned: 0,
    total: 0,
    indexVersion: 0,
    lastError,
    foldersVisited: 0,
    subrequests: NO_SUBREQUESTS_SPENT,
    rowsWritten: 0,
    stoppedBy: null,
    resumeAt: null,
  };
}
