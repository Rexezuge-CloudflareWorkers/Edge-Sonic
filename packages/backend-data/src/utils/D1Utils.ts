import { DatabaseError } from '@edge-sonic/backend-errors';
import type { D1Result } from './D1Types';
import { attemptFromRunResult, attemptFromThrown } from './d1RetryOutcome';
import type { AttemptOutcome } from './d1RetryOutcome';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void) => void): unknown => setTimeout(resolve, ms));
}

/**
 * Exponential backoff: 100ms, 200ms, 400ms… up to `maxRetries` attempts.
 */
function backoffDelay(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * Math.pow(2, attempt);
}

/**
 * Run a D1 operation, retrying only faults the classifier calls transient.
 *
 * Generic over the result type because **reads** need the same treatment as
 * writes. A `first()`/`all()` does not return a `D1Result`, so a
 * `D1Result`-only signature would force every read to bypass retry — and a read
 * that throws on a transient fault is exactly the one that should be retried.
 * The alternative, catching at each read site, is where "wrap the read in
 * `.catch(() => null)`" habits come from, and that turns an outage into a 404.
 *
 * The `!result.success` inspection is guarded by a shape check rather than a cast
 * to `D1Result`, so a read result (which has no `success` field) passes straight
 * through instead of being read as a failure.
 */
async function executeD1WithRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<T> {
  const maxRetries: number = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs: number = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const canRetry: boolean = attempt < maxRetries;

    let outcome: AttemptOutcome;
    try {
      const result: T = await operation();
      // Only a `run()` result carries `success`. Anything else is a read, and a read has no
      // success flag to check — so a read is never mistaken for a failed write.
      if (!isRunResult(result) || result.success) return result;
      outcome = await attemptFromRunResult(result, context, canRetry, attempt, baseDelayMs);
    } catch (error: unknown) {
      outcome = await attemptFromThrown(error, context, canRetry, attempt, baseDelayMs);
      // Recorded only on this path, matching the original: a `success: false` refusal is a
      // D1-reported fault rather than a thrown one, and the final `throw` below reports the
      // last thing D1 actually raised.
      if (outcome.kind === 'retry' && error instanceof Error) lastError = error;
    }

    if (outcome.kind === 'throw') throw outcome.error;
  }

  throw lastError ?? new DatabaseError(`Failed to ${context} after ${maxRetries + 1} attempts`);
}

function isRunResult(value: unknown): value is D1Result {
  return typeof value === 'object' && value !== null && 'success' in value;
}

export { backoffDelay, executeD1WithRetry, sleep };
export { attemptFromRunResult, attemptFromThrown } from './d1RetryOutcome';
export type { AttemptOutcome } from './d1RetryOutcome';
