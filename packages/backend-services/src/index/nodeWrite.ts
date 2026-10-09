/**
 * Whether a node row needs writing, and the one answer both writers must give.
 *
 * ### Why this is its own module
 *
 * Because `nodes` has **two** writers — `reconcileFolder` and `TreeService.persistChildren` —
 * and a compare is exactly the kind of thing that gets written twice, drifts, and is then
 * half-believed. `persistChildren` had one. `reconcileFolder` described one in its own
 * docstring and did not have it:
 *
 * > **Does this node row need rewriting?** Answered by the child's own mtime and etag.
 *   `upsertFileFacts` deliberately leaves derived metadata alone, so a redundant write would
 *   spend a row to rewrite values that are already correct.
 *
 * A correct description of a comparison that was not there. So the scan re-offered every child
 * of every folder it opened, `runWriteBatch` truncated the offer against the invocation's
 * ceiling, and the rows it had already written were the rows it re-offered first — so the
 * truncation always landed at the same offset, `truncated` was permanently true, and the one
 * write the scan may not skip (the folder's own `is_scanned: true`) never happened. A folder
 * with more entries than fit in one invocation could not be closed at all, and every chunk
 * rewrote the same rows instead.
 *
 * The two writers also had to disagree on purpose, which is why the predicate takes the
 * desired `is_scanned` as an argument rather than deciding it: the scan knows which children it
 * has descended into and the browse has read nothing below them. See
 * `persistChildren`'s call site for why the browse now *preserves* that flag rather than
 * clearing it.
 *
 * ### Why the compared columns are named here and not in the caller
 *
 * Because the statement is the other half of the comparison. `NodeDAO.UPSERT` carries the same
 * list as a `WHERE`, and a predicate that compared `mtime_ms` alone would let the two disagree:
 * the caller decides a row is unchanged, the statement decides it is not, or the reverse. If a
 * column is added to the `DO UPDATE` and not to this list, the write is invisible — which is why
 * `test/scan-convergence.test.ts` asserts convergence rather than the contents of this list, and
 * why the statement's own guard is asserted separately against it.
 *
 * `updated_at` is deliberately absent, because it is the one column that always differs; see
 * the statement.
 */
import type { NodeRow } from '@edge-sonic/backend-data/dao';

/**
 * What a caller wants a row to say. Every field is a column the statement writes.
 */
interface DesiredNodeRow {
  readonly parentPath: string;
  readonly name: string;
  readonly mtimeMs: number | null;
  readonly etag: string | null;
  readonly depth: number;
  /**
   * `0` or `1`, and never absent — a caller that does not know is not asking this question.
   */
  readonly isScanned: boolean;
}

/**
 * Whether this row has to be written at all.
 *
 * `true` for an unknown row, because that is an insert rather than an update, and an insert is
 * a row written whatever the comparison says.
 *
 * ### Why the etag comparison is two-sided null and not "either is non-null"
 *
 * Because the permissive direction here is the dangerous one. `persistChildren` compared
 * `(resource.etag !== null && known.etag !== null && known.etag !== resource.etag)` — a row that
 * *had* an etag and no longer gets one looks unchanged, so the stale etag is kept and a
 * subtree whose only change was an etag is frozen. `IS NOT`-style comparison on both columns
 * catches that; the cost is rewriting a row whose etag went from a value to `null`, which is a
 * real change and should be a write.
 */
function nodeRowNeedsWrite(known: NodeRow | undefined, desired: DesiredNodeRow): boolean {
  if (known === undefined) return true;
  return (
    known.parent_path !== desired.parentPath ||
    known.name !== desired.name ||
    known.mtime_ms !== desired.mtimeMs ||
    known.etag !== desired.etag ||
    known.depth !== desired.depth ||
    known.is_scanned !== (desired.isScanned ? 1 : 0)
  );
}

export { nodeRowNeedsWrite };
export type { DesiredNodeRow };
