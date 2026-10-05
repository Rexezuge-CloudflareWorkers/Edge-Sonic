/**
 * The import phases, and the scan pause they run under.
 *
 * ### Why the import **pauses the scan** rather than sharing its budget
 *
 * `dailyRowWriteShare` exists because D1's 5,000-rows/day allowance is per **account**, so N
 * libraries each capped at the whole allowance would write N times it. The same argument
 * applies to an import and is stronger, because an import is not a background process that
 * happens to run alongside: since 2026-09-01 an account over its daily allowance has **every
 * query fail** until midnight UTC — reads included. Two writers racing for the last rows do
 * not each get slower; the second one takes the whole product down, `/rest` authentication
 * included, and the remedy is a clock rather than a change.
 *
 * So there is **one writer at a time**. The import refuses to start while any library is
 * `scanning`, and holds scans off for its duration. That is honest and simple, and the
 * alternative — a three-way split of the allowance — buys nothing: it makes two things slow
 * rather than keeping one safe.
 *
 * ### Two questions, two predicates, because `scanPause.ts` already learned this
 *
 * An import is a **pause with a known end that the operator chose**, which is closer to a
 * spent allowance than to a fault:
 *
 * - it resolves **without a poll**, so the scan's alarm must stay **armed** and sleep to the
 *   end (`willResumeWithoutAPoll`, not `isAdvancing`);
 * - it is **not a fault**, so `consecutive_failures` must **not** be charged. Charging it
 *   would eventually produce `stalled`, which deletes the alarm and leaves the scan
 *   unrecovered until somebody notices.
 *
 * ### The pause is refused, not merely slowed
 *
 * `assertScansIdle` throws when a scan is running rather than waiting for it. An import that
 * waited would hold an HTTP request open for as long as the scan took, against the same
 * 45-second client timeout the scan's own deadline exists for — and the operator's answer to
 * "it did nothing" would be to press it again.
 */
import { ConflictError } from '@edge-sonic/backend-errors';
import { dailyRowWriteShare } from '@edge-sonic/backend-runtime/config';

/**
The statuses in which a library is still doing work.
*/
const SCANNING_STATUSES = ['scanning', 'marking'];

/**
What the import needs to know about each library's scan.
*/
interface ScanStateReader {
  /**
  Every library's stored scan row, or `null` for a library that has never been scanned.
  */
  listAll(): Promise<ReadonlyArray<{ readonly library_id: string; readonly status: string } | null>>;
}

/**
The run's share of the day's rows, derived exactly as a scan's is.
*/
function importDailyRowBudget(enabledLibraries: number): number {
  return dailyRowWriteShare(Math.max(1, enabledLibraries));
}

/**
 * Refuse to start while any library is scanning.
 *
 * Named rather than folded into the caller, because "is anything else writing right now" is
 * the single most consequential precondition this feature has and it deserves one answer in
 * one place. It re-reads every library's row rather than trusting a status the operator's page
 * happens to be showing.
 */
async function assertScansIdle(scans: ScanStateReader): Promise<void> {
  const rows = await scans.listAll();
  const busy = rows
    .filter((row): row is { readonly library_id: string; readonly status: string } => row !== null)
    .filter((row) => SCANNING_STATUSES.includes(row.status));
  if (busy.length === 0) return;
  throw new ConflictError(
    `The scan is running on ${busy.length} librar${busy.length === 1 ? 'y' : 'ies'}. An import pauses the scan so the two do not compete for the daily row-write allowance — wait for the scan to finish, or stop it, then start the import.`,
  );
}

/**
 * Whether an import is currently running, from the runs table.
 *
 * `running` and `paused` both count, and they mean opposite things to different callers: the
 * scan's alarm must keep running *through* a paused import (it is the only thing that can
 * resume it), while a second import must be refused. Both are answered by "is there an import
 * in flight", which is the question neither of them should answer for itself.
 */
function isImportInFlight(run: { readonly one: unknown; readonly running: number } | null): boolean {
  return run !== null && run.running > 0;
}

export { assertScansIdle, importDailyRowBudget, isImportInFlight, SCANNING_STATUSES };