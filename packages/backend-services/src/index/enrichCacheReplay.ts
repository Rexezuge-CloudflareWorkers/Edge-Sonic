/**
 * Replaying a `songMeta` cache entry into D1, without a second origin read.
 *
 * Own module rather than inline in `EnrichmentService` because that file is over the
 * god-file limit and this is the block that does not belong: the entry-to-patch mapping
 * is one decision — which fields a cached enrichment carries into `applyMetadata` — and
 * both `enrichFacts` callers (the row-holding path replays through `persist`, the facts
 * path through the store) must agree on it by construction rather than by parallel code.
 */
import { READER_VERSION, EMPTY_TAGS } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { CachedEnrichment } from './songMetaCache';

interface CachedFactsMetadata {
  readonly duration: number;
  readonly bitrate: number;
  readonly readerVersion: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly album?: string | null;
  readonly albumArtist?: string | null;
  readonly genre?: string | null;
  readonly year?: number | null;
  readonly track?: number | null;
  readonly disc?: number | null;
}

/**
 * The `applyMetadata` patch a complete cache entry implies.
 *
 * A replayed row is still a write — measured, not declared — and a row already current
 * reports `0` by measurement: `applyMetadata` reports its own `changes`, so the caller
 * paces off what happened rather than what was attempted.
 *
 * The tags are replayed when the entry carries them, and that is the whole point of
 * carrying them: a row recreated after the read (an index drop deletes `songs` but not
 * this cache) holds path-derived names, and a technical-only replay would stamp those
 * guesses current with a correct duration — a release named after its sanitized folder,
 * never re-read. Absent means "leave alone" downstream, so an entry for a genuinely
 * untagged file replays nothing it should not.
 */
function metadataFromCachedEnrichment(cached: CachedEnrichment): CachedFactsMetadata {
  return {
    duration: Math.max(0, Math.round(cached.durationSeconds ?? 0)),
    bitrate: cached.bitrateKbps === null ? 0 : Math.max(0, Math.round(cached.bitrateKbps)),
    readerVersion: READER_VERSION,
    ...(cached.sampleRate !== null && { sampleRate: cached.sampleRate }),
    ...(cached.channels !== null && { channels: cached.channels }),
    ...(cached.title != null && { title: cached.title }),
    ...(cached.artist != null && { artist: cached.artist }),
    ...(cached.album != null && { album: cached.album }),
    ...(cached.albumArtist != null && { albumArtist: cached.albumArtist }),
    ...(cached.genre != null && { genre: cached.genre }),
    ...(cached.year != null && { year: cached.year }),
    ...(cached.track != null && { track: cached.track }),
    ...(cached.disc != null && { disc: cached.disc }),
  };
}

/**
 * The cached tags as a tag read, for the row-holding replay path.
 *
 * `null` when the entry carries no tags at all — a genuinely untagged file, or an
 * entry written before tags were cached — so the caller leaves the row's grouping
 * alone rather than blanking it. Built on `EMPTY_TAGS` rather than by hand so a new
 * tag field defaults exactly as a fresh read would report it.
 */
function tagsFromCachedEnrichment(cached: CachedEnrichment): AudioTags | null {
  if (
    cached.title == null &&
    cached.artist == null &&
    cached.album == null &&
    cached.albumArtist == null &&
    cached.genre == null &&
    cached.year == null &&
    cached.track == null &&
    cached.disc == null
  ) {
    return null;
  }
  return {
    ...EMPTY_TAGS,
    title: cached.title ?? null,
    artist: cached.artist ?? null,
    album: cached.album ?? null,
    albumArtist: cached.albumArtist ?? null,
    genre: cached.genre ?? null,
    year: cached.year ?? null,
    track: cached.track ?? null,
    disc: cached.disc ?? null,
  };
}

export { metadataFromCachedEnrichment, tagsFromCachedEnrichment };
export type { CachedFactsMetadata };
