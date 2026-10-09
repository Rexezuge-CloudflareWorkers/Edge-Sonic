/**
 * Enriching the tracks a scan chunk changed.
 *
 * Split out of `ScanService` because it is a different concern from the walk: the scan
 * decides *what* changed, and this decides what that costs.
 *
 * ### Why the scan enriches at all
 *
 * Enrichment used to be reachable only from `getSong`, so a browsing client saw
 * `duration: 0` and no artist on every track until it happened to open one — and
 * `getArtists`, `getAlbumList2`, `getGenres` and `search3` had nothing to group on, so
 * they were all empty for a library of 81 artists. The scan already knows which rows
 * changed and already holds their facts, so this is where the read belongs.
 *
 * ### Why it is bounded three times
 *
 * Three bounds, and they are not the same one:
 *
 * - `maxPerFolder` bounds the *shape* of a folder. Without it, one album of 500
 *   changed tracks takes every poll for itself and the walk never advances.
 * - `budget` bounds the *chunk*, and is shared with everything else the chunk does —
 *   the `PROPFIND`s, the D1 statements, the prune. Enrichment takes the remainder: a
 *   wide-changed album can end its own chunk. That is the trade this makes
 *   deliberately, because a chunk that ends early is resumable and a chunk that exceeds
 *   the platform's ceiling is not — it is an invocation the platform terminates with an
 *   error nothing in here can catch.
 * - `canAfford(REQUESTS_PER_ENRICHED_TRACK)` is the per-track reservation, and it is the
 *   one that was wrong.
 *
 * ### Why the reservation was `2` and had to become `5`
 *
 * `MAX_REQUESTS_PER_TRACK` counted the two **external** requests — a prefix read and, for a
 * container whose length is recorded at the end of the file, a tail read. It is now
 * `SUBSREQUESTS_PER_ENRICHED_TRACK`, and the reason is the whole defect:
 *
 * | Step                                | Subrequest |
 * | ----------------------------------- | ---------- |
 * | `songMeta` KV read (miss on a cold row) | 1      |
 * | prefix ranged `GET`                 | 1          |
 * | tail ranged `GET` (Ogg only)        | 0–1        |
 * | `songs.applyMetadata`               | 1          |
 * | `songMeta` KV write                 | 1          |
 *
 * Five, or six for an Ogg track, against a ceiling of 50 for the whole invocation. Admitting
 * twenty tracks per folder on the cost of two each is admitting a hundred subrequests of work
 * onto a budget of fifty, which is not a slow chunk — it is a terminated one.
 *
 * So the reservation is the **worst case**, and it is derived in `subrequests.ts` rather than
 * written here, for the reason every other bound in this codebase is derived: a number typed
 * beside the code that has to honour it is a number that is wrong by the time the platform
 * changes.
 *
 * ### Why failures are swallowed
 *
 * A track that cannot be read keeps `enriched_at = null` and is retried by `getSong`. The
 * scan's rows are already written by this point, and one unavailable origin must not
 * discard them — which is what a throw here would do.
 *
 * ### Why this returns a row count — and why two of them
 *
 * Because this function used to return `void`, and the daily D1 row-write allowance it paces
 * is the resource that silently ran out: the **subrequest** meter saw every `applyMetadata`,
 * because `BaseDAO.withRetry` charges each statement, while the row-write budget saw none of
 * them. One counter blind to a quarter of a cold scan's writes, beside one that counted them
 * all, is the shape of the defect this fixes — a hand-summed count at the call site is a
 * *claim* about the work, and the writer most likely to be forgotten is the one that is not the
 * caller.
 *
 * Two counts now, and the second is the correction rather than a refinement. D1's allowance is
 * denominated in **billed** rows — the row plus every index entry it rewrote — and `songs`
 * carries nine indexes, so one of these writes bills ten. A function that could only report
 * `1` per track had no way to say so, which is why the budget it feeds was short by an order of
 * magnitude on the enrichment path for as long as it existed.
 *
 * The count is rows **written**, not tracks asked about, and the difference is not academic:
 * a `songMeta` cache hit returns without touching D1, and a transient failure returns without
 * touching D1 — the second deliberately, since stamping the row over a `503` is what made four
 * tracks of a live library report `duration: 0` for ever. Counting those would pace the scan
 * against writes that never happened, and would stop it early rather than late.
 */
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { SUBSREQUESTS_PER_ENRICHED_TRACK } from '@edge-sonic/backend-runtime/config';
import type { ScanBudget } from './scanBudget';
import type { ScanEnrichFacts, ScanSongInput } from './scanTypes';

/**
 * The most subrequests one track's enrichment can issue.
 *
 * Re-exported under its old name as well, because the tests that pin the shape of the budget
 * name it, and a rename that silently left them importing a deleted symbol would turn a
 * behaviour change into a compile error rather than a decision.
 */
const REQUESTS_PER_ENRICHED_TRACK = SUBSREQUESTS_PER_ENRICHED_TRACK;

/**
 * Enrich the tracks a listing changed, within both bounds.
 *
 * @param enrich The caller's `enrichSong`, absent when a deployment has not opted in.
 * @param budget The chunk's budget. The meter it wraps is the *same* counter the DAOs and the
 *   KV cache charge, so a range read and the statement that records it are counted against one
 *   ceiling rather than two.
 * @returns Both counts for the tracks it admitted: `rowsWritten` is table rows written to
 *   `songs` — `0` for a track served from cache, `0` for one that failed transiently, and `0`
 *   for a track the budget had no room for — and `billedRows` is what those rows cost against
 *   the day's D1 row-write allowance. The two are reported together because the scan needs both:
 *   the first for `indexChanged`, the second for the daily budget, which is denominated in
 *   billed rows and so cannot be fed a table-row count.
 */

/**
 * What a batch of enriched tracks wrote, and what it cost.
 *
 * `billedRows` is `0` whenever `rowsWritten` is, and otherwise ten per row: the `songs` factor.
 * It is measured by `EnrichmentService` from the statement's own result rather than derived here,
 * so a caller that changes what the enrichment write touches cannot leave this module's
 * arithmetic describing something the database no longer does.
 */
interface EnrichmentCost {
  readonly rowsWritten: number;
  readonly billedRows: number;
}

/**
 * No track admitted, so nothing written and nothing spent — a measured zero rather than an
 * absent field, for the same reason every other empty result in this repository is a value.
 */
const NO_ENRICHMENT_COST: EnrichmentCost = { rowsWritten: 0, billedRows: 0 };
async function enrichChanged(
  library: LibraryRow,
  songInputs: readonly ScanSongInput[],
  enrich: ((library: LibraryRow, facts: ScanEnrichFacts, onRequest?: () => void) => Promise<EnrichmentCost>) | undefined,
  maxPerFolder: number,
  budget: ScanBudget,
): Promise<EnrichmentCost> {
  if (enrich === undefined || songInputs.length === 0) return NO_ENRICHMENT_COST;

  let rowsWritten = 0;
  let billedRows = 0;
  const bounded = songInputs.slice(0, Math.max(0, maxPerFolder));
  for (const input of bounded) {
    // Checked before each track, so the chunk stops taking on work rather than discovering
    // afterwards that it overran. `canAfford` takes the worst case, so an Ogg track's second
    // range read is inside the reservation rather than an overrun discovered afterwards.
    if (!budget.canAfford(REQUESTS_PER_ENRICHED_TRACK)) break;
    try {
      // Both counts come off the caller's own report, which is measured rather than declared.
      // That distinction is the whole reason this returns a pair: the scan's daily budget is
      // denominated in **billed** rows, `songs` bills ten per row written, and a
      // caller-incremented `1` here would under-report the single most expensive write in a
      // chunk by a factor of ten.
      const written = await enrich(library, { id: input.id, path: input.path, size: input.size, mtimeMs: input.mtimeMs }, () =>
        budget.charge(),
      );
      rowsWritten += written.rowsWritten;
      billedRows += written.billedRows;
    } catch {
      // Left for `getSong` to retry, for the reason in the header. And it wrote nothing, so
      // it contributes nothing to either count — which is the one place a swallowed
      // exception and a counted write have to be told apart.
    }
  }
  return { rowsWritten, billedRows };
}

export { enrichChanged, REQUESTS_PER_ENRICHED_TRACK, NO_ENRICHMENT_COST };
export type { EnrichmentCost };
