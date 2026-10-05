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
 * ### Why this returns a row count
 *
 * Because `rowsWritten` is the only input to `ScanDailyBudget.rowsWrittenToday` — the guard
 * that stops the scan spending the account's D1 row-write allowance — and this function used
 * to return `void`. Every row `applyMetadata` wrote was therefore invisible to it, while the
 * **subrequest** meter saw each one, because `BaseDAO.withRetry` charges every statement. One
 * counter blind to a quarter of a cold scan's writes, beside one that counted them all, is the
 * shape of the defect this fixes: a hand-summed count at the call site is a claim about the
 * work, and the class of writer most likely to be forgotten is the one that is not the caller.
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
 * @returns Rows written to `songs`, which is `0` for a track served from cache, `0` for one
 *   that failed transiently, and `0` for a track the budget had no room for.
 */
async function enrichChanged(
  library: LibraryRow,
  songInputs: readonly ScanSongInput[],
  enrich: ((library: LibraryRow, facts: ScanEnrichFacts, onRequest?: () => void) => Promise<number>) | undefined,
  maxPerFolder: number,
  budget: ScanBudget,
): Promise<number> {
  if (enrich === undefined || songInputs.length === 0) return 0;

  let rowsWritten = 0;
  const bounded = songInputs.slice(0, Math.max(0, maxPerFolder));
  for (const input of bounded) {
    // Checked before each track, so the chunk stops taking on work rather than discovering
    // afterwards that it overran. `canAfford` takes the worst case, so an Ogg track's second
    // range read is inside the reservation rather than an overrun discovered afterwards.
    if (!budget.canAfford(REQUESTS_PER_ENRICHED_TRACK)) break;
    try {
      rowsWritten += await enrich(library, { id: input.id, path: input.path, size: input.size, mtimeMs: input.mtimeMs }, () => budget.charge());
    } catch {
      // Left for `getSong` to retry, for the reason in the header. And it wrote nothing, so
      // it contributes nothing to `rowsWritten` — which is the one place a swallowed
      // exception and a counted write have to be told apart.
    }
  }
  return rowsWritten;
}

export { enrichChanged, REQUESTS_PER_ENRICHED_TRACK };