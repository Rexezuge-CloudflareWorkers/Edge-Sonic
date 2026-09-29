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
 * ### Why it is bounded twice
 *
 * Two bounds, and they are not the same one:
 *
 * - `maxPerFolder` bounds the *shape* of a folder. Without it, one album of 500
 *   changed tracks takes the whole chunk budget on its first folder and the walk never
 *   advances.
 * - `budget` bounds the *chunk*, and is shared with the `PROPFIND`s the walk itself
 *   issues. Enrichment takes the remainder: a wide-changed album can end its own chunk.
 *   That is the trade this makes deliberately, because a chunk that ends early is
 *   resumable and a chunk that exceeds the platform's ceiling is not.
 *
 * ### Why failures are swallowed
 *
 * A track that cannot be read keeps `enriched_at = null` and is retried by `getSong`. The
 * scan's rows are already written by this point, and one unavailable origin must not
 * discard them — which is what a throw here would do.
 */
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { ScanBudget } from './scanBudget';
import type { ScanEnrichFacts, ScanSongInput } from './scanTypes';

/**
 * The most subrequests one track's enrichment can issue.
 *
 * A prefix read, plus a tail read for a container whose length is only recorded at the
 * end of the file (Ogg). Admitting a track on the cost of one is how a budget gets spent
 * past its ceiling, and the cost is knowable up front precisely because the second read
 * is conditional on the container the first one identified.
 */
const MAX_REQUESTS_PER_TRACK = 2;

/**
 * Enrich the tracks a listing changed, within both bounds.
 *
 * @param enrich The caller's `enrichSong`, absent when a deployment has not opted in.
 * @param budget The chunk's budget. Its meter is forwarded to `enrich`, so a range read
 *   is charged to the same ceiling as the `PROPFIND` that found the file.
 */
async function enrichChanged(
  library: LibraryRow,
  songInputs: readonly ScanSongInput[],
  enrich: ((library: LibraryRow, facts: ScanEnrichFacts, onRequest?: () => void) => Promise<void>) | undefined,
  maxPerFolder: number,
  budget: ScanBudget,
): Promise<void> {
  if (enrich === undefined || songInputs.length === 0) return;

  const bounded = songInputs.slice(0, Math.max(0, maxPerFolder));
  for (const input of bounded) {
    // Checked before each track, so the chunk stops taking on work rather than
    // discovering afterwards that it overran.
    if (!budget.canAfford(MAX_REQUESTS_PER_TRACK)) return;
    try {
      await enrich(library, { id: input.id, path: input.path, size: input.size, mtimeMs: input.mtimeMs }, () => budget.charge());
    } catch {
      // Left for `getSong` to retry, for the reason in the header.
    }
  }
}

export { enrichChanged, MAX_REQUESTS_PER_TRACK };
