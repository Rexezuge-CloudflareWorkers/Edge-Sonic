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
import { MAX_CONSECUTIVE_FAILURES } from './scanTypes';
import type { ChunkResult, ScanStatus } from './scanTypes';
import type { ScanStateRow } from '@edge-sonic/backend-data/dao';

/**
 * What a poll may do, given the stored state.
 *
 * `'run'` and `'stalled'` are the decisions `step` branches on. `'idle'` is separated
 * from `'stalled'` because they are opposites in what they tell a client: one means
 * "nothing is happening and nothing is wrong", the other means "something is wrong and
 * retrying has stopped helping".
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
 * A poll that will do no work, reported from stored state.
 *
 * `foldersVisited`, `webdavRequests` and `rowsWritten` are all zero because they are
 * **measured**, not defaulted: this call issued no request and wrote no row, and a
 * non-zero number here would be a claim the service cannot support. `lastError` is
 * carried so the reason a scan is incomplete survives a poll that touched nothing — the
 * operator API is the only surface that can show it, and this is where it comes from.
 */
function idleResult(state: ScanStateRow, status: 'idle' | 'failed' | 'stalled'): ChunkResult {
  return {
    status,
    scanned: state.scanned_count,
    total: state.total_count,
    indexVersion: state.index_version,
    // `null` only for a genuinely idle scan: an `idle` row's `last_error` is already
    // NULL, and a scan nobody is asking about is not the place to explain itself.
    lastError: status === 'idle' ? null : state.last_error,
    foldersVisited: 0,
    webdavRequests: 0,
    rowsWritten: 0,
    stoppedBy: null,
  };
}

/**
 * A failed scan whose retry budget is spent, reported without touching the network.
 *
 * Reached from `step` before any `PROPFIND`, which is the point: the bound exists so a
 * permanently broken library is not re-attempted, and a check that ran *after* the first
 * request would already have spent one.
 */
function stalledResult(state: ScanStateRow): ChunkResult {
  return idleResult(state, 'stalled');
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
async function unableToAdvance(state: ScanStateRow, fail: (error: string) => Promise<number>): Promise<ChunkResult> {
  const message = state.last_error ?? 'The library root could not be read, so the scan has no folder to start from.';
  const consecutiveFailures = await fail(message);
  return idleResult(state, consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'stalled' : 'failed');
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

export { decideStep, idleResult, stalledResult, unableToAdvance, isAdvancing,  };
export type { StepDecision };

export {MAX_CONSECUTIVE_FAILURES} from './scanTypes';