/**
 * Which D1 failures are worth trying again, which are a spent quota, and which are a
 * deployment that never applied its migrations.
 *
 * ### Why the quota is its own question, and not a retryable pattern
 *
 * Since 2026-09-01 a Workers Free account that exceeds its daily D1 row read or row write
 * limit has **every query fail** — reads included, through the binding API and the REST API
 * alike — until the limit resets at midnight UTC. Cloudflare's own words:
 *
 * > Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or
 * > wait until tomorrow (midnight UTC) to continue.
 *
 * Three consequences, and each one is a different answer to a different question.
 *
 * - **It is not transient.** `RETRYABLE_PATTERNS` deliberately does not match it: retrying a
 *   refusal that cannot change for hours spends the operator's requests to reach the same
 *   conclusion, which is the definition of the unbounded retry this file's neighbour guards
 *   against.
 * - **It is not a fault of the deployment**, so it must not be masked as a generic 5xx. The
 *   whole product is down — Subsonic authentication reads `users` — and "server error" sends
 *   an operator to debug their own server, which is the claim `LibraryService.probe` was
 *   rewritten to stop making.
 * - **It has a known end**, which no other D1 fault has: midnight UTC. That is why this
 *   returns the reset time rather than a boolean, and why the scan can resume *by itself*
 *   instead of either retrying in a loop or waiting for an operator.
 *
 * The reset is arithmetic rather than something to ask about: D1 resets at midnight UTC, so
 * the next reset is a function of the clock. `nextMidnightUtc` is that function, injected
 * wherever it is asserted, because the interesting cases are all at the boundary — a reset
 * computed as already-past is a zero-second pause, which is a one-invocation-per-second loop
 * wearing the costume of a fix.
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /busy/i,
  /locked/i,
  /timeout/i,
  /timed?\s*out/i,
  /internal\s+(server\s+)?error/i,
  /connection/i,
  /network/i,
  /unavailable/i,
  /throttl/i,
  /too\s+many/i,
  /retry/i,
  /deadlock/i,
  /serialization/i,
];

const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /constraint/i,
  /unique/i,
  /primary\s+key/i,
  /foreign\s+key/i,
  /not\s+found/i,
  /syntax/i,
  /parse\s+error/i,
  /no\s+such\s+(table|column|index)/i,
  /type\s+mismatch/i,
  /range/i,
  /permission/i,
  /authorization/i,
  /authentication/i,
  /invalid\s+argument/i,
  // Deterministic query-shape faults must never retry: `too many SQL variables`
  // is a bind-ceiling defect fixed by batching, not a transient. Without this,
  // `/too\s+many/i` in RETRYABLE_PATTERNS retries it 3x with backoff.
  /too\s+many\s+SQL\s+variables/i,
];

/**
 * Cloudflare's refusal, as it arrives.
 *
 * Matched on the substring rather than the whole message because the message reaches this
 * layer inside a wrapper: `executeD1WithRetry` throws
 * `Failed to ${context}: ${errorMessage}`, and a classifier that required the bare sentence
 * would answer "not a quota" for a quota. The two words that identify it are `exceeded` and
 * `daily`, and both are load-bearing — `too many` is deliberately absent, because a row that
 * says "too many SQL variables" is a defect this repository ships guards for, not a spent
 * allowance, and treating it as a quota would park the scan until midnight over a query that
 * one batching change fixes.
 */
const DAILY_LIMIT_PATTERN = /exceeded\s+D1'?s?\s+free\s+tier\s+daily\s+row\s+(read|write)\s+limit/i;

/**
 * Milliseconds in a day. Named so the UTC arithmetic below reads as what it is rather than as
 * a number somebody chose.
 */
const MS_PER_DAY = 86_400_000;

/**
 * Which daily allowance is spent, and when it comes back.
 *
 * `resetsAt` is epoch milliseconds and is always **strictly in the future** for the clock it
 * was computed from — including at exactly midnight, where the naive subtraction yields a
 * time that has already passed. That case is not a rounding detail: a pause whose reset is in
 * the past is a pause of zero length, and a chunk that returns immediately is a chunk that
 * re-runs its whole failure path at the alarm's rate.
 */
interface D1DailyLimit {
  readonly kind: 'read' | 'write';
  readonly resetsAt: number;
}

/**
 * The next midnight UTC after `nowMs`, in epoch milliseconds.
 *
 * UTC and not local: D1's reset is UTC, so a local-time calculation is wrong twice a day —
 * once by the offset and once because the two midnights disagree.
 */
function nextMidnightUtc(nowMs: number): number {
  const dayMs = nowMs - (nowMs % MS_PER_DAY);
  return dayMs + MS_PER_DAY;
}

/**
 * The spent daily allowance, or `null` for any other failure.
 *
 * `null` rather than `false` because the answer carries two facts, and a boolean forces every
 * caller to recompute the reset time — which is exactly the second answer to one question that
 * this repository keeps paying for.
 */
function isD1DailyLimitError(error: unknown, nowMs: number = Date.now()): D1DailyLimit | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = DAILY_LIMIT_PATTERN.exec(message);
  if (!match) return null;
  return { kind: match[1]?.toLowerCase() === 'read' ? 'read' : 'write', resetsAt: nextMidnightUtc(nowMs) };
}

function isD1ErrorRetryable(errorMessage: string): boolean {
  if (!errorMessage) return false;

  // A spent daily allowance is checked **before** both lists, and it is the one reason this
  // function is not the whole answer to "should this be tried again". An account over its
  // row-write limit is refused a message about upgrading, and adding `/exceeded/` to
  // `RETRYABLE_PATTERNS` would turn a refusal that cannot change for hours into three
  // attempts with backoff per statement, per chunk, per alarm.
  if (DAILY_LIMIT_PATTERN.test(errorMessage)) return false;

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) return false;
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) return true;
  }

  return false;
}

// Fail-closed helper (hardening): distinguishes "unit fake missing a table
// or column" (safe to degrade to [] / fallback query) from genuine D1
// failures (must propagate as DatabaseError, never silent []). Production
// D1 always carries the full baseline schema (0021+); the classifier now
// guards fake-DB shapes and deploy skew, not legacy migrations.
// Callers must only swallow `true` here; everything else rethrows.
function isMissingSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /no\s+such\s+(?:table|column|index)/i.test(message);
}

export { isD1ErrorRetryable, isMissingSchemaError, isD1DailyLimitError, nextMidnightUtc, DAILY_LIMIT_PATTERN };
export type { D1DailyLimit };