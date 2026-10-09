/**
 * Walking one page of a remote's albums, inside one alarm's budget.
 *
 * ### Why the loop is not in the Durable Object
 *
 * Because it is a **decision**, and `PlayCountImportWorker.ts` is over the soft god-file limit. Two
 * decisions are in here and neither is about scheduling:
 *
 * - **When to stop**, which is checked against the album's *whole* cost rather than the one call
 *   about to be made. A batch that admits an album it cannot finish does not get a slow album — it
 *   gets a terminated invocation with this batch's earlier rows written and the ones after it lost.
 *   That is how a walk that reports progress can still make none.
 * - **What a refusal means.** `setPlayCounts` is `requireComplete`: an album whose counted tracks do
 *   not fit in what remains refuses rather than writing half an album's **absolute** values. So the
 *   refusal is about *this alarm's* budget rather than about the album, and the album is retried on a
 *   fresh budget next alarm.
 *
 * Everything above this function is scheduling — the alarm, the pause, the settle — and everything
 * inside it is arithmetic over a page.
 */
import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { runPlayCountAlbumPhase } from '@edge-sonic/backend-services/import';
import type { PhaseContext } from '@edge-sonic/backend-services/import';
import type { SubrequestCounter } from '@edge-sonic/shared';

/**
 * One statement budget's worth of cost, or wall-clock, spent on one page.
 *
 * A **read** rather than a mutable object, so the caller cannot widen it between the check and the
 * call: the deadline is a number and the meter is the shared one, and neither is this module's to
 * change while a walk is in flight.
 */
interface WalkBounds {
  /**
  The scope's own meter, already narrowed to this batch's ceiling.
  */
  readonly meter: SubrequestCounter;
  /**
  Wall-clock, already absolute. Checked before each album, not once per batch.
  */
  readonly deadline: number;
  /**
  The whole cost of one album's step — not its one `getAlbum` call.
  */
  readonly costPerAlbum: number;
}

/**
 * What one page produced.
 *
 * `deferredForBudget` is separate from `exhausted` because they are different claims about the
 * remote and the caller has to be able to tell them: "there are no more albums" is a finished walk,
 * and "I could not afford these" is a walk that continues on the next alarm. Collapsing them is how
 * a walk reports completion after doing a fraction of the work.
 */
interface PageOutcome {
  readonly albums: number;
  readonly songs: number;
  readonly unresolved: number;
  /**
  Stopped early on the budget rather than running out of albums.
  */
  readonly deferredForBudget: boolean;
}

/**
 * Walk `page` until the album list ends or the budget does.
 *
 * The page is walked in order and **not** re-fetched per album, which is the entire reason the
 * per-album phase is separate from the per-page one: a batch of seven albums costs one enumeration
 * call and seven `getAlbum` calls rather than seven of each.
 */
async function walkAlbumPage(
  phaseContext: PhaseContext,
  page: readonly { readonly id: string; readonly name: string | null }[],
  bounds: WalkBounds,
): Promise<PageOutcome> {
  let albums = 0;
  let songs = 0;
  let unresolved = 0;

  for (const album of page) {
    if (!bounds.meter.canAfford(bounds.costPerAlbum) || Date.now() >= bounds.deadline) {
      // Not an error: the counts so far are banked and the rest is the next alarm's.
      return { albums, songs, unresolved, deferredForBudget: true };
    }
    try {
      const outcome = await runPlayCountAlbumPhase(phaseContext, album);
      albums += 1;
      songs += outcome.imported;
      unresolved += outcome.unresolvedCount;
    } catch (error) {
      if (error instanceof SubrequestBudgetExhaustedError) {
        return { albums, songs, unresolved, deferredForBudget: true };
      }
      // Anything else is the walk's own fault, and `alarm` records it and re-arms. Swallowing it
      // here would turn a poison album into a walk that reports progress and advances past it.
      throw error;
    }
  }
  return { albums, songs, unresolved, deferredForBudget: false };
}

export { walkAlbumPage };
export type { WalkBounds, PageOutcome };
