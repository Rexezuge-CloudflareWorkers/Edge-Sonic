/**
 * How one attempt of a D1 statement turned out, and what the retry loop should do about it.
 *
 * Split out of [`D1Utils.ts`](./D1Utils.ts) because the classification is the whole decision and
 * the loop is only the driver. While both shared a function, `executeD1WithRetry` held a `try`
 * with a nested `try`-free five-branch body, and the two error paths — a `run()` that answered
 * `success: false` and a statement that threw — could not be read without seeing the backoff
 * arithmetic interleaved with both.
 *
 * The split also names something that was implicit before: a D1 refusal arrives as a **value**
 * on one path and as a **throw** on the other, and only one of those reaches a `catch`. Two
 * functions, one per path, is the honest shape.
 */
import { DatabaseError } from '@edge-sonic/backend-errors';
import { isD1ErrorRetryable } from './D1ErrorClassifier';
import type { D1Result } from './D1Types';
import { backoffDelay, sleep } from './D1Utils';

/**
 * What the retry loop should do after one attempt.
 *
 * A discriminated pair rather than a returned `Error`, because the two answers are not the same
 * kind of thing: `retry` means "nothing was thrown, go again", and `throw` means "a value to
 * throw". A function returning `Error | undefined` makes those indistinguishable at the call
 * site, and the distinction is what the loop is for.
 */
type AttemptOutcome = { readonly kind: 'retry' } | { readonly kind: 'throw'; readonly error: unknown };

const RETRY: AttemptOutcome = { kind: 'retry' };

const throwWith = (error: unknown): AttemptOutcome => ({ kind: 'throw', error });

/**
 * Turn a `run()` that came back `success: false` into the loop's next move.
 *
 * A separate function because the refusal arrives as a **value**, not a throw, so it cannot reach
 * the `catch` that classifies thrown errors — and a reader who misses that sees two independent
 * error paths with no reason for there to be two. The backoff is deferred here rather than in the
 * loop so the success-value path and the thrown path sleep in the same place.
 */
async function attemptFromRunResult(
  result: D1Result,
  context: string,
  canRetry: boolean,
  attempt: number,
  baseDelayMs: number,
): Promise<AttemptOutcome> {
  const errorMessage: string = result.error ?? 'Unknown database error';
  const retryable: boolean = isD1ErrorRetryable(errorMessage);
  if (retryable && canRetry) {
    await sleep(backoffDelay(baseDelayMs, attempt));
    return RETRY;
  }
  return throwWith(new DatabaseError(`Failed to ${context}: ${errorMessage}`, retryable));
}

/**
 * Classify a thrown error: retry it, rethrow it untouched, or wrap it as a `DatabaseError`.
 *
 * Three answers, and each is a different thing rather than three spellings of one. A
 * `DatabaseError` carries the `retryable` verdict its own constructor already decided, so it is
 * rethrown unchanged — re-classifying it from its message would let `isD1ErrorRetryable` disagree
 * with the answer recorded when the error was created. A throw that is not an `Error` at all (a
 * rejected string, or anything else) is rethrown untouched: there is no message to classify, and
 * inventing one would replace what the caller threw with a guess about what they meant.
 */
async function attemptFromThrown(
  error: unknown,
  context: string,
  canRetry: boolean,
  attempt: number,
  baseDelayMs: number,
): Promise<AttemptOutcome> {
  if (error instanceof DatabaseError) {
    if (error.retryable && canRetry) {
      await sleep(backoffDelay(baseDelayMs, attempt));
      return RETRY;
    }
    return throwWith(error);
  }
  if (error instanceof Error) {
    const retryable: boolean = isD1ErrorRetryable(error.message);
    if (retryable && canRetry) {
      await sleep(backoffDelay(baseDelayMs, attempt));
      return RETRY;
    }
    return throwWith(new DatabaseError(`Failed to ${context}: ${error.message}`, retryable));
  }
  return throwWith(error);
}

export { attemptFromRunResult, attemptFromThrown, RETRY };
export type { AttemptOutcome };
