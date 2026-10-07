/**
 * `executeD1WithRetry`: the retry boundary every DAO read and write crosses.
 *
 * A transient D1 fault is classified by message text; a non-transient one
 * must reach the caller on the first attempt, not after three backoffs. The
 * `run()`-result path differs from the throw path because a run carries a
 * `success` flag that a read never has — guarded incorrectly, a thrown run
 * error would be retried as though it were transient, and a transient one
 * would surface as a silent `false` instead of a retry.
 */
import { describe, expect, it } from 'vitest';
import { executeD1WithRetry } from '@edge-sonic/backend-data/utils';

const TRANSIENT = 'D1 is temporarily unavailable';

describe('executeD1WithRetry', () => {
  it('retries a transient thrown error until it succeeds', async () => {
    let calls = 0;
    const result = await executeD1WithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(TRANSIENT);
        return 'ok';
      },
      'read the songs',
      { baseDelayMs: 0, maxRetries: 3 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await expect(
      executeD1WithRetry(
        async () => {
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
      executeD1WithRetry(
        async () => {
          calls += 1;
          return { success: false, error: TRANSIENT, meta: {} };
        },
        'write the rows',
        { baseDelayMs: 0, maxRetries: 2 },
      ),
    ).rejects.toThrow('Failed to write the rows');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('passes a read result (no success flag) straight through', async () => {
    let calls = 0;
    const result = await executeD1WithRetry(
      async () => {
        calls += 1;
        return { results: [], meta: {} };
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
      executeD1WithRetry(
        async () => {
          calls += 1;
          throw new Error(TRANSIENT);
        },
        'read the frontier',
        { baseDelayMs: 0, maxRetries: 1 },
      ),
    ).rejects.toThrow('Failed to read the frontier');
    expect(calls).toBe(2);
  });
});
