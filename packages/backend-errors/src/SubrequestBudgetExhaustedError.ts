import { PayloadTooLargeError } from '@rexezuge/errors';

/**
 * A write could not be issued because the invocation's subrequest budget was already spent.
 *
 * Local shim, kept in `backend-errors` until the kit publishes the converged
 * class (proposed in the SDK repo: `SubrequestBudgetExhaustedError extends
 * PayloadTooLargeError` with `type` overridden, the `DatabaseError` precedent,
 * so the catalog keeps one row per status). When that lands, delete this file
 * and re-point its importers at `@rexezuge/errors` — the name is identical, so
 * it is one specifier per file and no call-site change.
 *
 * ### Why this is a distinct error and not a `DatabaseError`
 *
 * Because it names its own cause and the remedy is different. A `DatabaseError` says D1
 * refused something; this says the request asked for more work than one Worker invocation is
 * allowed to do, and the two want opposite responses — the first is the server's problem to
 * log, the second is the server's problem to *size*.
 *
 * ### Why it exists at all, given the platform kills the invocation anyway
 *
 * For the writes that must be **all or nothing**. A scan's index write is resumable — the
 * folder stays on the frontier and the next chunk finishes it — so a truncated batch there is
 * reported rather than raised (`WriteBatchResult.truncated`). A play queue is not: half a
 * queue is a *shorter queue*, which is a wrong answer rather than an unfinished one, and it is
 * indistinguishable from a queue the client genuinely shortened. So those writes refuse to
 * start rather than starting and stopping.
 *
 * A `413`, not a `400`: the request is well-formed and the server understood it perfectly —
 * it is the *size* of what was asked for that this plan cannot serve in one invocation. Same
 * class as `PayloadTooLargeError`, and the client-facing remedy is the same shape — ask for
 * less in one request.
 */
class SubrequestBudgetExhaustedError extends PayloadTooLargeError {
  constructor(message?: string) {
    super(message ?? 'This request asks for more database work than one invocation can issue. Send fewer items at once.');
    this.type = 'SubrequestBudgetExhausted';
  }
}

export { SubrequestBudgetExhaustedError };
