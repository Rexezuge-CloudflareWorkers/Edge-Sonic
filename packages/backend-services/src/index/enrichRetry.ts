/**
 * Whether a library-wide enrichment may run another chunk, and what to tell an
 * operator when it may not.
 *
 * The scan's twin (`scanRetry.ts`), and a twin rather than a reuse for one reason:
 * the two answer different questions about what happens next. A scan's `scanning`
 * and an enrichment's `enriching` both mean "more work remains", but they are
 * advanced by different alarms on different objects — collapsing them would let one
 * loop's re-arm answer for the other, and an enrich alarm deleted by a scan predicate
 * is an enrich run that never resumes.
 *
 * So this module mirrors the scan's two questions rather than importing them:
 * `isEnrichAdvancing` answers the *page's* question ("will looking again change what
 * I read?"), and `willEnrichResumeWithoutPoll` answers the *alarm's* ("must the chain
 * stay armed?"). `paused` splits them here for the same reason it does there — polling
 * cannot move a wall clock, but deleting the alarm would leave a spent allowance
 * unrecovered until an operator noticed.
 */
import { isD1DailyLimitError, nextMidnightUtc } from '@edge-sonic/backend-data/utils';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import { LAST_ERROR_MAX } from './scanTypes';
import type { SubrequestSpend } from '@edge-sonic/shared';

/**
 * An enrichment run's state, as the service reports it.
 *
 * `enriching` is the scan's `scanning` under the name the operator reads: the run holds
 * remaining work and its alarm is armed. `failed` is retried within its bound, `stalled`
 * has spent it, and `paused` waits for midnight UTC by itself.
 */
type EnrichStatus = 'idle' | 'enriching' | 'failed' | 'stalled' | 'paused';

/**
 * What one enrich chunk did, and what remains.
 *
 * `enriched` is this chunk's delta — tracks stamped by this call — not a running total:
 * the run's total lives in the Durable Object's storage beside the retry counter, because
 * metering must not itself spend D1 writes. `remaining` is measured after the chunk, so
 * the operator watches one number fall rather than two numbers that have to agree.
 */
interface EnrichChunkResult {
  readonly status: EnrichStatus;
  /**
   * Tracks this chunk stamped. Progress, and what the run's total accumulates.
   */
  readonly enriched: number;
  /**
   * Tracks still owing a tag read after this chunk. The completion signal: zero means the
   * next poll has nothing to do, and the run goes `idle`.
   */
  readonly remaining: number;
  readonly lastError: string | null;
  readonly subrequests: SubrequestSpend;
  /**
   * Table rows changed: progress, and what `scan-convergence` measures on the scan side.
   * Not the allowance.
   */
  readonly rowsWritten: number;
  /**
   * What they cost the platform, and what the day's budget is charged.
   */
  readonly billedRows: number;
  /**
   * Which bound ended this chunk, or `null` for one that did no work. The scan's
   * `ChunkStopReason`, shared rather than redeclared: a bound is a bound whichever loop
   * hit it, and two names for it would be two remedies for one cause.
   */
  readonly stoppedBy: 'frontier' | 'requests' | 'deadline' | null;
  /**
   * When this run will be attempted again on its own, epoch milliseconds, or `null`.
   *
   * `null` for every result that is not `paused`, including one that ran out of tracks —
   * the next chunk is the next alarm and nothing needs saying about it.
   */
  readonly resumeAt: number | null;
}

function isEnrichAdvancing(status: EnrichStatus): boolean {
  return status === 'enriching' || status === 'failed';
}

function willEnrichResumeWithoutPoll(status: EnrichStatus): boolean {
  return status === 'enriching' || status === 'failed' || status === 'paused';
}

/**
 * A chunk that will not run until `resumeAt`, reported without touching the network.
 *
 * Every counter is zero because nothing was measured — the allowance check runs before
 * the first track, so a pause decided on the Durable Object's count has issued no write
 * beyond the guard reads. The reason names the hour, because "paused" alone tells an
 * operator nothing about whether to wait or to act.
 */
function enrichPausedResult(resumeAt: number, lastError: string, remaining = 0): EnrichChunkResult {
  return {
    status: 'paused',
    enriched: 0,
    remaining,
    lastError,
    subrequests: NO_SUBREQUESTS_SPENT,
    rowsWritten: 0,
    billedRows: 0,
    stoppedBy: null,
    resumeAt,
  };
}

/**
 * A run with nothing left to do, reported from a live remaining count.
 */
function enrichIdleResult(remaining: number): EnrichChunkResult {
  return {
    status: 'idle',
    enriched: 0,
    remaining,
    lastError: null,
    subrequests: NO_SUBREQUESTS_SPENT,
    rowsWritten: 0,
    billedRows: 0,
    stoppedBy: null,
    resumeAt: null,
  };
}

/**
 * Whether the day's row-write allowance is spent, and so this chunk must not issue a write.
 *
 * The scan's check, over the same budget shape: the allowance is per account and both
 * loops spend it, so an enrich chunk that started over it would write until the platform
 * refused every query — reads included — rather than pausing.
 */
function enrichDailyWriteAllowanceSpent(budget: { billedRowsWrittenToday: number; limit: number } | undefined): boolean {
  return budget !== undefined && budget.limit > 0 && budget.billedRowsWrittenToday >= budget.limit;
}

/**
 * The pause a spent daily share implies, or `null` when this chunk may write.
 */
function enrichDailyAllowancePause(
  budget: { billedRowsWrittenToday: number; limit: number; now: () => number } | undefined,
  remaining: number,
): EnrichChunkResult | null {
  if (!enrichDailyWriteAllowanceSpent(budget) || budget === undefined) return null;
  return enrichPausedResult(
    nextMidnightUtc(budget.now()),
    `This library has written its ${budget.limit}-row share of today's D1 row-write allowance. The enrichment resumes itself at 00:00 UTC.`,
    remaining,
  );
}

/**
 * The pause a spent D1 allowance implies, or `null` for any other fault.
 *
 * First branch in the caller's `catch`, before anything is recorded: the fault *is* a
 * refusal to write, so recording it would cost a statement that cannot succeed.
 */
function enrichD1AllowancePause(error: unknown, nowMs: number, remaining = 0): EnrichChunkResult | null {
  const limit = isD1DailyLimitError(error, nowMs);
  if (!limit) return null;
  return enrichPausedResult(
    limit.resetsAt,
    limit.kind === 'write'
      ? 'The daily D1 row-write allowance is used up. D1 refuses every query until 00:00 UTC, so the enrichment resumes itself then.'
      : 'The daily D1 row-read allowance is used up. D1 refuses every query until 00:00 UTC, so the enrichment resumes itself then.',
    remaining,
  );
}

/**
 * A failure's text, bounded to what an operator can be shown.
 *
 * The same bound the scan persists (`LAST_ERROR_MAX`), shared rather than retyped: the
 * text originates upstream either way, and two bounds are two places to drift.
 */
function describeEnrichFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX);
}

export {
  enrichDailyAllowancePause,
  enrichDailyWriteAllowanceSpent,
  enrichD1AllowancePause,
  enrichIdleResult,
  enrichPausedResult,
  describeEnrichFailure,
  isEnrichAdvancing,
  willEnrichResumeWithoutPoll,
};
export { MAX_CONSECUTIVE_FAILURES } from './scanTypes';
export type { EnrichChunkResult, EnrichStatus };
