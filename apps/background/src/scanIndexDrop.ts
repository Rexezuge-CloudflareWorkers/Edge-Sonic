/**
 * The Danger Zone's half of the scan Durable Object: stop it, and charge it for what it spent.
 *
 * ### Why this is a module and not two methods on `ScanWorker`
 *
 * Three reasons, and the first is the same one that put `scanPause.ts` beside `ScanWorker`.
 *
 * 1. **`ScanWorker` is over the god-file limit.** It is a router: routing and composition, with
 *    the pause's state machine and the day's budget in `scanPause.ts`. Two more methods with
 *    three paragraphs of reasoning each would push it past 400 lines, and the answer to that is
 *    never "shorten the reasoning".
 * 2. **Both decisions are about `ScanWorker`'s storage, not about scanning.** Neither advances
 *    the walk, neither reads `scan_state`, and neither would mean anything without
 *    `ScanPauseStore` — which is the module they sit beside now.
 * 3. **`ScanWorker` can delegate, and the delegation is the assertion that matters.** A test
 *    that drives a real `ScanWorker` proves the RPCs reach the right storage; a test that calls
 *    these functions proves the reasoning is stated once. Both exist in
 *    `test/index-drop-do.test.ts`.
 *
 * ### Why the object is stopped **before** the D1 deletes
 *
 * A live alarm fires every second. If one fires between the delete of `songs` and the delete of
 * `nodes`, `step` finds a frontier describing rows that no longer exist, walks the origin and
 * writes fresh song rows — landing *after* the delete meant to have removed them. The operator
 * is told their index is empty and it is not, with nothing anywhere recording that anything
 * happened.
 *
 * The alarm has to be deleted from **this** object for the result to be a fact rather than a
 * race: the alternative is the drop believing it has won a race it is not in.
 */
import type { ScanPauseStore } from './scanPause';

/**
 * Delete the alarm and forget a held pause, without advancing the walk.
 *
 * ### Why a held pause is cleared too
 *
 * `getStatus` **overlays** a held pause over the stored status, because a pause is usually
 * caused by D1 refusing writes and so cannot be recorded in the row it would override — that is
 * the one status `scan_state` is guaranteed stale about. A pause surviving a drop therefore
 * renders "paused until 00:00 UTC" over a library with nothing in it, and the operator's only
 * conclusion is that the drop did not work.
 *
 * ### Why the day's billed-row count is **kept**
 *
 * It counts what this deployment has already spent, and deleting an index spends allowance like
 * any other write: `songs` bills ten rows per row deleted, so a 5,000-track drop is roughly
 * 55,000 rows of a 100,000-row day. Forgetting that would let the next scan believe in headroom
 * the platform has already refused, which is how an account-wide outage is reached rather than
 * survived. `chargeBelow` adds the measured figure.
 *
 * ### What is deliberately untouched
 *
 * The library id and the frontier. The id is what makes a later `startScan` land on the right
 * library, and seeding the frontier here would put every folder back on `is_scanned = 0` — which
 * is the state `listFrontier` reads, so the very next chunk would walk the whole origin and write
 * the index the operator just deleted. Seeding is `start`'s job alone.
 */
async function stopForIndexDrop(ctx: DurableObjectState, pause: ScanPauseStore): Promise<void> {
  await ctx.storage.deleteAlarm();
  // `clear` unconditionally, with **no** "is there a pause?" guard here.
  //
  // The guard was written, and removing it turned nothing red — which is the useful part.
  // `ScanPauseStore.clear` already returns without writing when nothing is held, so the check
  // was a second read of a state the callee owns, and the reason it would have mattered is the
  // storage allowance this deployment spends ~86,000 entries a day on tracking D1's own: a
  // redundant `held()` read per drop is a read against it, spent for nothing.
  //
  // `test/index-drop-do.test.ts` asserts the observable consequence — "writes nothing when there
  // was no pause to clear" — which is the property worth keeping, and which a guard *here* would
  // have made look load-bearing.
  await pause.clear();
}

/**
 * Add already-billed rows to the count of today's D1 writes.
 *
 * The caller passes what the `DELETE`s **measured** rather than a projection — the same number
 * `runWriteStatement` reported, so the counter is never ahead of or behind the platform.
 *
 * It routes through `ScanPauseStore`'s own accumulation rather than writing the `memory` key
 * directly, because that key is written on an interval and on a day rollover, and a third writer
 * would have to reproduce both. `pendingRows` is the mechanism for exactly this: a figure that
 * is real but not yet persisted, and which the next chunk will fold into its own write.
 *
 * A non-positive figure is ignored at both layers. `charge` short-circuits before it reaches
 * storage, and `addPendingRows` will not accept a negative, because subtracting from the day's
 * spend would hand the next scan a budget larger than the platform's — the exact over-count
 * `scanPause.ts` was rebuilt to eliminate.
 */
async function chargeForIndexDrop(pause: ScanPauseStore, billedRows: number): Promise<void> {
  if (billedRows <= 0) return;
  pause.addPendingRows(billedRows);
  await pause.flushIfDue();
}

export { stopForIndexDrop, chargeForIndexDrop };
