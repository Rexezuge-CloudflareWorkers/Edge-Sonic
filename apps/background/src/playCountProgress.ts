/**
 * The play-count walk's **published** progress, beside the walk's own.
 *
 * ### Why this is separate from `PlayCountImportWorker`
 *
 * Because the walk keeps two records of the same number, for two different readers, and the gap
 * between them is a silent one:
 *
 * | Where | Who reads it |
 * | --- | --- |
 * | this Durable Object's storage (`WalkProgress`) | `PlayCountImportWorker.status()` |
 * | D1 (`import_play_count_progress`) | `GET /user/import/:id` |
 *
 * The operator's import page polls the **HTTP route**, not the object — the route is behind Access
 * and the object is not addressable from a browser. So the Durable Object's copy advanced correctly
 * through a walk while the page showed nothing at all, and `GET /user/import/:id` reported
 * `playCounts: null` for every real import: a field on the wire with nothing behind it.
 *
 * `ImportPlayCountProgressDAO` had `ensure`, `advance` and `markFinished` written and **no caller**
 * — only its `read` was ever called, by that route. Three writers, no writer.
 *
 * So this module is the writing side of one DAO, and the class calls it in three places rather than
 * inlining three statements twice. It is also why `PlayCountImportWorker.ts` is not over the god-file
 * limit: the reasoning belongs beside the DAO it explains, not in the alarm handler that calls it.
 */
import type { Token } from '@edge-sonic/backend-runtime/di';
import { Tokens } from '@edge-sonic/backend-services/composition';

/**
 * The minimum this module needs from a request scope.
 *
 * **Structurally** the container's shape rather than the concrete `Container` class, because the
 * dependency is "something that can hand me this token" and nothing else — a test can pass an object
 * with one `get` and no environment behind it, and the class would force a real scope for three calls.
 * The method is typed over `Token<T>` so the DAO each call receives is inferred, not asserted.
 */
interface ProgressScope {
  get<T>(token: Token<T>): T;
}

/**
 * Create the cursor row on a walk's first batch, and be a no-op after that.
 *
 * **Idempotent** (`INSERT OR IGNORE`) and therefore safe on every alarm: the walk is alarm-chained
 * and issues tens of statements per batch, so one more is the honest price of a row that cannot be
 * half-created. `ensure` also reads back and throws if the row is not there, which is the property
 * that makes the two writes below safe to make unconditionally.
 *
 * A walk that never calls this has published no progress, and the route's `null` then means "the
 * walk has not begun" — which the SPA renders differently from "began and imported nothing".
 */
async function ensureProgress(scope: ProgressScope, runId: string): Promise<void> {
  const dao = await scope.get(Tokens.ImportPlayCountProgressDAO)();
  await dao.ensure(runId);
}

/**
 * Add one batch's counts, as a **delta**.
 *
 * A delta rather than an absolute total, for the reason `ScanStateDAO.saveProgress` is: two
 * overlapping batches would otherwise each publish their own total and the smaller one would win, so
 * the number would go **backwards** while the work was being done — and an operator watching progress
 * go down has no way to tell that from a fault.
 *
 * `lastRemoteAlbumId` is the cursor and `albumsDone` the tiebreak, because a remote album id is not
 * guaranteed to sort in walk order across two different servers — an ordering assumption here would
 * silently skip or repeat albums on any source whose ids are not monotonic.
 *
 * **Not best-effort.** A batch whose rows were written and whose published count was not is exactly
 * the disagreement this pair of records exists to prevent, so it fails loudly into `alarm`'s bounded
 * retry rather than publishing a number that is behind the work.
 */
async function advanceProgress(
  scope: ProgressScope,
  runId: string,
  lastRemoteAlbumId: string | null,
  albums: number,
  songs: number,
): Promise<void> {
  const dao = await scope.get(Tokens.ImportPlayCountProgressDAO)();
  await dao.advance(runId, lastRemoteAlbumId, albums, songs);
}

/**
 * Release the cursor once the walk is terminal.
 *
 * **Best-effort, and deliberately so.** The walk's outcome is settled by the `import_runs` update that
 * follows; refusing to record that because a bookkeeping write failed would trade an accurate answer
 * for a missing one, and a settled run with a stale cursor costs nothing that is read. The catch is
 * the one deliberate swallow on this path and it says so.
 */
async function releaseProgress(scope: ProgressScope, runId: string): Promise<void> {
  try {
    const dao = await scope.get(Tokens.ImportPlayCountProgressDAO)();
    await dao.markFinished(runId);
  } catch {
    // The run's own status is the truth about the walk; this only clears a resume position that no
    // terminal walk will read. Logged nowhere because there is nothing an operator can do about it.
  }
}

export { ensureProgress, advanceProgress, releaseProgress };
export type { ProgressScope };
