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
 * ### Why it is bounded
 *
 * A cold scan of 5,000 tracks would be 5,000 subrequests, and Workers allow 1,000 per
 * request. So the count per folder is capped, and whatever exceeds it keeps
 * `enriched_at = null` and is enriched on first play instead — the path that was already
 * carrying the whole feature. A track with no duration until someone opens it is a
 * degraded answer; a chunk that exceeds the subrequest limit fails outright.
 *
 * ### Why failures are swallowed
 *
 * A track that cannot be read keeps `enriched_at = null` and is retried by `getSong`. The
 * scan's rows are already written by this point, and one unavailable origin must not
 * discard them — which is what a throw here would do.
 */
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { ScanEnrichFacts, ScanSongInput } from './scanTypes';

/**
 * Enrich the tracks a listing changed, up to the per-folder bound.
 *
 * @param enrich The caller's `enrichSong`, absent when a deployment has not opted in.
 */
async function enrichChanged(
  library: LibraryRow,
  songInputs: readonly ScanSongInput[],
  enrich: ((library: LibraryRow, facts: ScanEnrichFacts) => Promise<void>) | undefined,
  maxPerFolder: number,
): Promise<void> {
  if (enrich === undefined || songInputs.length === 0) return;

  for (const input of songInputs.slice(0, Math.max(0, maxPerFolder))) {
    try {
      await enrich(library, { id: input.id, path: input.path, size: input.size, mtimeMs: input.mtimeMs });
    } catch {
      // Left for `getSong` to retry, for the reason in the header.
    }
  }
}

export { enrichChanged };
