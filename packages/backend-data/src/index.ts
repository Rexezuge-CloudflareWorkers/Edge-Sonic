// The DAOs, the AES-GCM envelope, and the billed-row table.
//
// What used to live here as well — `D1Utils`, `D1ErrorClassifier`, `D1Types` and
// `d1RetryOutcome`, 387 lines in four files — is `@rexezuge/d1`'s: one retry
// engine, one classifier with the daily-allowance detection, and one set of D1
// types. Each copy was forked for a reason that has since been answered in the
// kit:
//
// - `D1Utils`'s engine became `executeWithRetry`.
// - `D1ErrorClassifier`'s `DAILY_LIMIT_PATTERN`, `isD1DailyLimitError` and
//   `nextMidnightUtc` became part of the kit's classifier, tested before both
//   pattern lists so a spent allowance can never be classified retryable.
// - `D1Types`'s `TrackedStatement` became the kit's — a statement with the SQL
//   beside it, which is the only reason a write can be accounted at all, since
//   the platform's `D1PreparedStatement` carries no `sql`.
//
// `BaseDAO` extends the kit's and keeps only what is this repository's policy:
// the subrequest charge on the closure form, the group-splitting write batch, and
// the `billedRowsForTable` port.
export * from './dao/index';
export { generateAesGcmKey, encryptData, decryptData, isUsableKey, timingSafeEqualStrings } from './crypto/index';
export type { Encrypted } from './crypto/index';
