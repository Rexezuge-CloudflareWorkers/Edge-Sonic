/**
 * `executeWithRetry` — the kit's retry engine, which is the boundary every DAO
 * read and write in this repository now crosses.
 *
 * **This suite is a consumer assertion, not the engine's own.** The engine and
 * its classifier live in `@rexezuge/d1` and are tested there; what is asserted
 * here is that *this repository's* DAOs reach the boundary at all, and that the
 * behaviour they depended on survived the move — the local copy it replaced was
 * `D1Utils.executeD1WithRetry`, forked because the kit's base class could not
 * take a subrequest meter.
 *
 * A transient D1 fault is classified by message text; a non-transient one must
 * reach the caller on the first attempt, not after three backoffs. The
 * `run()`-result path differs from the throw path because a run carries a
 * `success` flag that a read never has — guarded incorrectly, a thrown run error
 * would be retried as though it were transient, and a transient one would
 * surface as a silent `false` instead of a retry.
 */
import { describe, expect, it } from 'vitest';
import { executeWithRetry } from '@rexezuge/d1';
import type { D1Result } from '@rexezuge/d1';

const TRANSIENT = 'D1 is temporarily unavailable';

/**
 * A result the engine treats as **success**, however many fields the caller
 * wants to read off it. The engine's own check is `success`, so this is what a
 * read resolves to.
 */
function ok(extra: Record<string, unknown> = {}): D1Result {
  return { results: [], meta: {}, ...extra } as unknown as D1Result;
}

describe('executeWithRetry', () => {
  it('retries a transient thrown error until it succeeds', async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async (): Promise<D1Result> => {
        calls += 1;
        if (calls < 3) throw new Error(TRANSIENT);
        return ok({ ok: true });
      },
      'read the songs',
      { baseDelayMs: 0, maxRetries: 3 },
    );
    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async (): Promise<D1Result> => {
          calls += 1;
          throw new Error('no such table: songs');
        },
        'read the songs',
        { baseDelayMs: 0 },
      ),
    ).rejects.toThrow('no such table');
    expect(calls).toBe(1);
  });

  it('retries a run result with success: false, and classifies the final one', async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async (): Promise<D1Result> => {
          calls += 1;
          return { success: false, error: TRANSIENT, meta: {} } as unknown as D1Result;
        },
        'write the rows',
        { baseDelayMs: 0, maxRetries: 2 },
      ),
    ).rejects.toThrow('Failed to write the rows');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('passes a read result (no success flag) straight through', async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async (): Promise<D1Result> => {
        calls += 1;
        return ok();
      },
      'list the rows',
      { baseDelayMs: 0 },
    );
    expect(result).toEqual({ results: [], meta: {} });
    expect(calls).toBe(1);
  });

  it('a transient throw that outlives the budget surfaces as a DatabaseError', async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async (): Promise<D1Result> => {
          calls += 1;
          throw new Error(TRANSIENT);
        },
        'read the frontier',
        { baseDelayMs: 0, maxRetries: 1 },
      ),
    ).rejects.toThrow('Failed to read the frontier');
    expect(calls).toBe(2);
  });

  it('does not retry a spent daily allowance', async () => {
    // The classification the local `D1ErrorClassifier` added and the kit now
    // carries: a refusal that cannot change for hours must not become three
    // attempts with backoff, per statement, per chunk, per alarm.
    let calls = 0;
    await expect(
      executeWithRetry(
        async (): Promise<D1Result> => {
          calls += 1;
          throw new Error("Your account has exceeded D1's free tier daily row write limit");
        },
        'write the rows',
        { baseDelayMs: 0 },
      ),
    ).rejects.toThrow(/daily row write limit/);
    expect(calls).toBe(1);
  });

  it('does not retry a bind-ceiling refusal', async () => {
    // `/too\s+many/i` is in the retryable list, so without the kit's narrowing
    // this deterministic query-shape defect is retried three times with backoff,
    // for ever, on a statement that fails identically each attempt.
    let calls = 0;
    await expect(
      executeWithRetry(
        async (): Promise<D1Result> => {
          calls += 1;
          throw new Error('too many SQL variables');
        },
        'read the albums',
        { baseDelayMs: 0 },
      ),
    ).rejects.toThrow(/too many SQL variables/);
    expect(calls).toBe(1);
  });
});
