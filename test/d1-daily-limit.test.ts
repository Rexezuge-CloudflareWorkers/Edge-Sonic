/**
 * A spent D1 daily allowance, which since 2026-09-01 takes the whole product down.
 *
 * ### What the platform actually does
 *
 * Cloudflare enforces the Free plan's 5,000-rows-written and 5-million-rows-read daily limits.
 * When an account exceeds either one, **every query fails** — reads included, through the binding
 * API and the REST API alike — until the limit resets at **midnight UTC**:
 *
 * > Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait
 * > until tomorrow (midnight UTC) to continue.
 *
 * Three consequences, and each is a different answer to a different question.
 *
 * - **It is not transient.** Retrying spends the operator's requests to reach the same conclusion
 *   for hours, which is the unbounded retry this repository treats as the opposite defect.
 * - **It is not a fault of the deployment.** Subsonic authentication reads `users`, so the whole
 *   product is down and a masked 500 sends an operator to debug their own database — the same
 *   mistake `LibraryService.probe` was rewritten to stop making.
 * - **It has a known end.** No other D1 fault does, and that is what makes a *pause* possible:
 *   the work resumes itself at a moment, needing neither an operator nor a `startScan`.
 *
 * ### What this server used to do with it
 *
 * `step` caught the refusal, tried to record it with a D1 write that could not succeed, and
 * returned `failed` with `consecutive_failures` incremented by nothing. `isAdvancing('failed')` is
 * true, so `ScanWorker` re-armed one second later and did the whole thing again — roughly 86,400
 * times before the reset, each attempt a failed statement and a failed write. `getScanStatus`
 * reported `scanning: true` throughout, which every client reads as *keep polling*, and the
 * reason existed only in an exception that `toSubsonicError` masked.
 *
 * So this file asserts four things, each paired: the classifier (with its negatives), the pause
 * (with the ordinary-fault case beside it), the alarm (with the one-second-loop case beside it),
 * and the diagnosis (on both dialects).
 */
import { describe, expect, it } from 'vitest';
import { DatabaseError } from '@edge-sonic/backend-errors';
import { isD1DailyLimitError, isD1ErrorRetryable, nextMidnightUtc } from '@edge-sonic/backend-data/utils';
import { ScanService, d1AllowancePause, isAdvancing, willResumeWithoutAPoll } from '@edge-sonic/backend-services/index';
import { SubrequestCounter } from '@edge-sonic/shared';
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import {
  D1_DAILY_ROW_WRITE_LIMIT,
  D1_DAILY_ROW_WRITE_RESERVE,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_DAILY_ROW_WRITE_BUDGET,
  WORKER_SUBSREQUEST_CEILING,
  dailyRowWriteShare,
} from '@edge-sonic/backend-runtime/config';

function library(): LibraryRow {
  return {
    id: 'L1',
    slug: 'home',
    slug_ci: 'home',
    base_url: 'https://dav.example.com',
    root_path: '/music',
    dav_username: 'ann',
    password_ciphertext: '',
    password_iv: '',
    key_version: 1,
    display_name: 'Home',
    is_enabled: 1,
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * Cloudflare's two messages, verbatim from the 2026-09-01 changelog.
 *
 * Quoted rather than paraphrased because the classifier matches on this text, and a paraphrase in
 * a test would be a paraphrase the classifier has never seen.
 */
const WRITE_LIMIT_MESSAGE =
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const READ_LIMIT_MESSAGE =
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

/**
An epoch timestamp as an ISO string, so a date assertion cannot be misread as a month index.
*/
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
A time comfortably inside one UTC day, so `nextMidnightUtc` is unambiguous.
*/
// Month indices are 0-based, so `9` is October — 5 October 2026.
const MIDDAY = Date.UTC(2026, 9, 5, 12, 0, 0);

describe('recognising a spent allowance', () => {
  it('reads the write limit, and when it resets', () => {
    const limit = isD1DailyLimitError(new Error(WRITE_LIMIT_MESSAGE), MIDDAY);

    expect(limit?.kind).toBe('write');
    expect(limit?.resetsAt).toBe(nextMidnightUtc(MIDDAY));
    expect(limit?.resetsAt).toBe(Date.UTC(2026, 9, 6, 0, 0, 0));
  });

  it('distinguishes the read limit from the write limit, because the remedies differ', () => {
    // Collapsing them into one boolean would leave an operator with a sentence about writes when
    // their problem is a read runaway — which is the more alarming of the two and has a different
    // cause entirely.
    expect(isD1DailyLimitError(new Error(READ_LIMIT_MESSAGE), MIDDAY)?.kind).toBe('read');
  });

  it('finds the message inside the wrapper the DAO throws', () => {
    // `executeD1WithRetry` throws `Failed to ${context}: ${errorMessage}`, so a classifier that
    // required the bare sentence would answer "not a quota" for a quota — and the whole branch
    // would be unreachable in production while every test passed.
    const wrapped = new DatabaseError(`Failed to scanState.ensure: ${WRITE_LIMIT_MESSAGE}`, false);
    expect(isD1DailyLimitError(wrapped, MIDDAY)?.kind).toBe('write');
  });

  it('answers null for every other D1 fault', () => {
    // The negative half, and it is the half that matters: a classifier that matched on a word like
    // "limit" would park a scan until midnight UTC over a query one batching change fixes.
    const others = [
      'Failed to nodes.upsertMany: no such table: nodes',
      'Failed to songs.find: FOREIGN KEY constraint failed',
      'Failed to scanState.find: D1_ERROR: too many SQL variables: bound 101, D1 allows 100.',
      'Failed to users.find: connection reset by peer',
      'Failed to playlists.save: UNIQUE constraint failed: playlists.slug',
    ];
    for (const message of others) {
      expect(isD1DailyLimitError(new Error(message), MIDDAY), message).toBeNull();
    }
  });

  it('is never retryable, and says so before the retryable patterns are consulted', () => {
    // `too many` is in `RETRYABLE_PATTERNS` and `exceeded` is not, so this passes today by
    // accident of vocabulary. It is asserted because the day somebody adds `/exceeded/` — an
    // entirely reasonable-looking change — this becomes three attempts with backoff per statement,
    // per chunk, per alarm, for a refusal that cannot change for hours.
    expect(isD1ErrorRetryable(WRITE_LIMIT_MESSAGE)).toBe(false);
    expect(isD1ErrorRetryable(READ_LIMIT_MESSAGE)).toBe(false);
  });
});

describe('the reset is arithmetic, and the boundary is where it matters', () => {
  it('is the next midnight UTC, never the one that has passed', () => {
    expect(nextMidnightUtc(MIDDAY)).toBe(Date.UTC(2026, 9, 6));
    expect(nextMidnightUtc(Date.UTC(2026, 9, 5, 23, 59, 59))).toBe(Date.UTC(2026, 9, 6));
  });

  it('is strictly in the future at exactly midnight', () => {
    // The one case a naive subtraction gets wrong: `now % MS_PER_DAY === 0` makes "the next
    // midnight" the midnight that is happening *now*. The result is a pause of zero length, and a
    // caller that re-arms on a zero-length pause is back to one invocation per second — the exact
    // loop the pause exists to stop, wearing the costume of its own fix.
    const midnight = Date.UTC(2026, 9, 5, 0, 0, 0);
    expect(nextMidnightUtc(midnight)).toBeGreaterThan(midnight);
    expect(nextMidnightUtc(midnight)).toBe(Date.UTC(2026, 9, 6));
  });

  it('rolls the month and the year over', () => {
    // A 30-day month and a 31-day month, because the naive version — adding 24 hours until the
    // clock reads midnight — gets one of them wrong, and the wrong one is a reset a day out.
    //
    // Written with explicit ISO strings on the expected side, because this assertion is exactly
    // where a hand-counted month index goes wrong. `Date.UTC(2026, 8, 31)` is 1 **October** —
    // September has 30 days — and the first version of this test asserted a rollover that was a
    // month out while appearing, in the source, to say what it meant. Spelled as dates rather than
    // as indices, the arithmetic cannot be misread.
    expect(iso(nextMidnightUtc(Date.UTC(2026, 8, 30, 23, 0, 0)))).toBe('2026-10-01T00:00:00.000Z');
    expect(iso(nextMidnightUtc(Date.UTC(2026, 9, 31, 23, 0, 0)))).toBe('2026-11-01T00:00:00.000Z');
    expect(iso(nextMidnightUtc(Date.UTC(2026, 11, 31, 23, 0, 0)))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('survives the leap day, because a year is not always 365 days', () => {
    // 2028 is a leap year, so the window after 28 February is 29 February rather than 1 March. A
    // reset computed with a hard-coded month length is a day out, every leap year, for ever.
    expect(iso(nextMidnightUtc(Date.UTC(2028, 1, 28, 23, 0, 0)))).toBe('2028-02-29T00:00:00.000Z');
  });
});

describe('the pause, and the ordinary fault beside it', () => {
  it('pauses with a resume time and a sentence naming it', () => {
    const pause = d1AllowancePause(new Error(WRITE_LIMIT_MESSAGE), MIDDAY);

    expect(pause?.status).toBe('paused');
    expect(pause?.resumeAt).toBe(Date.UTC(2026, 9, 6));
    // The sentence is the whole content of the answer on this path, and it must name the *write*
    // limit specifically — an operator who has been reading rows needs to know writes are what ran
    // out.
    expect(pause?.lastError).toContain('row-write');
    expect(pause?.lastError).toContain('00:00 UTC');
    // "resumes itself" is the operative phrase: it is what tells an operator that nothing is
    // required of them, which is the difference between a pause and a failure.
    expect(pause?.lastError).toContain('resumes itself');
  });

  it('says "read" when reads are what ran out', () => {
    expect(d1AllowancePause(new Error(READ_LIMIT_MESSAGE), MIDDAY)?.lastError).toContain('row-read');
  });

  it('reports every counter as zero, because nothing was measured', () => {
    // Not a default. On this path `scan_state` could not be read, so a non-zero `scanned` would be
    // a claim about a library this call never looked at — the same reasoning as `unrecordedFailure`.
    const pause = d1AllowancePause(new Error(WRITE_LIMIT_MESSAGE), MIDDAY);

    expect(pause?.scanned).toBe(0);
    expect(pause?.indexVersion).toBe(0);
    expect(pause?.foldersVisited).toBe(0);
    expect(pause?.rowsWritten).toBe(0);
    expect(pause?.subrequests.total).toBe(0);
  });

  it('answers null for a fault that is not a spent allowance', () => {
    // The pair. Without it, the branch could return `paused` for a revoked credential or a
    // constraint violation, the alarm would be armed for midnight, and the operator would be told
    // to wait for a quota that was never the problem.
    expect(d1AllowancePause(new Error('Failed to scanState.find: FOREIGN KEY constraint failed'), MIDDAY)).toBeNull();
    expect(d1AllowancePause(new Error('Failed to scanState.find: connection reset by peer'), MIDDAY)).toBeNull();
    expect(d1AllowancePause(new Error('Failed to scanState.find: no such table: scan_state'), MIDDAY)).toBeNull();
  });
});

describe('two questions, and one predicate could not answer both', () => {
  it('keeps the alarm armed for a pause and answers the client that polling buys nothing', () => {
    // These are different questions and they have different answers for `paused`, which is why
    // there are two functions. `ScanWorker` needs "will this resume by itself?" — yes, at a known
    // moment — and `getScanStatus`'s `scanning` needs "will my poll change anything?" — no, because
    // the next chunk cannot run before a wall-clock moment and no amount of asking moves it.
    //
    // One predicate serving both is the shape of the defect `isAdvancing` records: `scanning`
    // answered "did this call do work", every client read `false` as *stop polling*, and the
    // library was never scanned. The mirror of that failure is a `paused` scan whose alarm is
    // deleted, which leaves an allowance spent and nothing scheduled to notice the reset.
    expect(willResumeWithoutAPoll('paused')).toBe(true);
    expect(isAdvancing('paused')).toBe(false);
  });

  it('agrees with the old predicate on every other status', () => {
    // Or the split is not a split: it is a second answer that drifted. `paused` is the only status
    // where the two differ, and it is the only one that needs them to.
    for (const status of ['idle', 'scanning', 'failed', 'stalled'] as const) {
      expect(willResumeWithoutAPoll(status)).toBe(isAdvancing(status));
    }
  });

  it('reports stalled as needing an operator and not a poll', () => {
    // The other direction, and unchanged by any of this: `stalled` has spent its retry budget and
    // nothing is scheduled, so the alarm must go.
    expect(willResumeWithoutAPoll('stalled')).toBe(false);
    expect(isAdvancing('stalled')).toBe(false);
  });

  it('reports failed as both, because a bounded retry is running by itself', () => {
    expect(willResumeWithoutAPoll('failed')).toBe(true);
    expect(isAdvancing('failed')).toBe(true);
  });
});

/**
 * `ScanService` with only the store surfaces this test needs.
 *
 * The refusal is injected at `ensure`, which is the first statement a chunk issues — so it is
 * refused before the walk, which is what production does. `fail` is left **working**, and that is
 * the whole point of the fixture: with a store where the counter *could* be incremented, a pause
 * that spent it would show up, and with a store where every write throws it could not — so a test
 * built on the second one asserts nothing.
 */
function serviceWhereEnsureFails(failCalls: { count: number }): ScanService {
  const state: ScanStateRow = {
    library_id: 'L1',
    status: 'scanning',
    cursor_path: null,
    scanned_count: 0,
    total_count: 0,
    index_version: 1,
    last_error: null,
    started_at: null,
    consecutive_failures: 0,
    updated_at: 0,
  };
  const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
  return new ScanService({
    subrequests: meter,
    timeoutMs: 1000,
    chunkFolders: 7,
    chunkMaxRequests: SCAN_CHUNK_SUBSREQUEST_BUDGET,
    chunkDeadlineMs: 20_000,
    enrichMaxPerFolder: 0,
    clientFor: async () => {
      throw new Error('the origin must not be reached');
    },
    scanState: {
      find: async () => state,
      ensure: async () => {
        throw new Error(`Failed to scanState.ensure: ${WRITE_LIMIT_MESSAGE}`);
      },
      markScanning: async () => undefined,
      saveProgress: async () => undefined,
      complete: async () => state.index_version,
      fail: async () => {
        failCalls.count += 1;
        return state.consecutive_failures + 1;
      },
    },
  } as never);
}

describe('the pause is decided before anything is recorded', () => {
  it('does not spend the retry budget, and never reaches the origin', async () => {
    // The pair for the `scan-do` case, and the one that can actually fail. There, every statement
    // throws, so the counter could not have been incremented either way and the assertion held
    // vacuously; here `fail` **works**, so a pause that charged it would leave a real count behind.
    //
    // The consequence of charging it is not cosmetic: `consecutive_failures` reaches
    // `MAX_CONSECUTIVE_FAILURES`, `storedStatus` then reports `stalled`, and `stalled` deletes the
    // alarm — so an allowance that resets at midnight would leave the scan un-recovered until an
    // operator pressed Rescan.
    const failCalls = { count: 0 };
    const service = serviceWhereEnsureFails(failCalls);

    const result = await service.step(library());

    expect(result.status).toBe('paused');
    expect(failCalls.count, 'a pause must not be recorded as a failure').toBe(0);
  });

  it('answers paused for a spent allowance and failed for every other fault', async () => {
    // The negative, and it is what stops the branch being an over-correction: a revoked credential
    // or a constraint violation must still be `failed`, so the retry counter bounds it.
    const revoked = { count: 0 };
    const service = new ScanService({
      subrequests: new SubrequestCounter(WORKER_SUBSREQUEST_CEILING),
      timeoutMs: 1000,
      chunkFolders: 7,
      chunkMaxRequests: SCAN_CHUNK_SUBSREQUEST_BUDGET,
      chunkDeadlineMs: 20_000,
      enrichMaxPerFolder: 0,
      clientFor: async () => {
        throw new Error('unreachable');
      },
      scanState: {
        find: async () => {
          throw new Error('Failed to scanState.find: FOREIGN KEY constraint failed');
        },
        ensure: async () => {
          throw new Error('Failed to scanState.ensure: FOREIGN KEY constraint failed');
        },
        markScanning: async () => undefined,
        saveProgress: async () => undefined,
        complete: async () => 1,
        fail: async () => {
          revoked.count += 1;
          return 1;
        },
      },
    } as never);

    const result = await service.step(library());

    expect(result.status).toBe('failed');
    expect(revoked.count, 'an ordinary fault is what the retry budget is for').toBe(1);
  });
});

describe('the budget is derived from the platform number, not typed beside it', () => {
  it('is the platform allowance less a reserve, and the reserve is non-zero', () => {
    expect(SCAN_DAILY_ROW_WRITE_BUDGET).toBe(D1_DAILY_ROW_WRITE_LIMIT - D1_DAILY_ROW_WRITE_RESERVE);
    // Non-zero is the load-bearing half. A zero reserve makes the scan's budget the whole
    // allowance, which leaves nothing for the stars, ratings, playlists and login-throttle writes
    // a client makes while a scan is running — and the scan is by far the largest consumer.
    expect(D1_DAILY_ROW_WRITE_RESERVE).toBeGreaterThan(0);
    expect(SCAN_DAILY_ROW_WRITE_BUDGET).toBeGreaterThan(0);
  });

  it('gives one library the whole budget, which is the ordinary deployment', () => {
    expect(dailyRowWriteShare(1)).toBe(SCAN_DAILY_ROW_WRITE_BUDGET);
  });

  it('divides between libraries, because the allowance is per account', () => {
    // Two libraries each capped at the whole allowance would write twice what D1 accepts between
    // them, and the reactive pause would be all that stood between that and an outage. The divisor
    // is the number of *registered* libraries rather than `MAX_LIBRARIES`, so a deployment with one
    // library out of ten configured still gets the whole budget instead of a tenth of it.
    expect(dailyRowWriteShare(2)).toBe(Math.floor(SCAN_DAILY_ROW_WRITE_BUDGET / 2));
    expect(dailyRowWriteShare(4) * 4).toBeLessThanOrEqual(SCAN_DAILY_ROW_WRITE_BUDGET);
  });

  it('never rounds a day budget down to zero', () => {
    // A scan allowed zero rows a day never completes, which is the same class of permanent failure
    // this mechanism exists to prevent — so the share floors at one. It is reached well before any
    // realistic library count: `4000 / 1` needs 4,001 libraries, which is why this reads as
    // theoretical and is asserted anyway. The cost of getting it wrong is a scan that never resumes
    // and a day that never ends.
    expect(dailyRowWriteShare(4001)).toBe(1);
    expect(dailyRowWriteShare(1_000_000)).toBeGreaterThanOrEqual(1);
    for (const count of [1, 2, 10, 100, 5000, 100_000]) {
      expect(dailyRowWriteShare(count), `count=${count}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('treats a zero or absent library count as one, rather than dividing by it', () => {
    // `0` libraries reaching this function is a caller bug, and the answer that keeps the scan
    // moving is the one that does not divide by zero.
    expect(dailyRowWriteShare(0)).toBe(SCAN_DAILY_ROW_WRITE_BUDGET);
  });
});