/**
 * Replaying a `songMeta` cache entry into D1, without a second origin read.
 *
 * Own module rather than inline in `EnrichmentService` because that file is over the
 * god-file limit and this is the block that does not belong: the entry-to-patch mapping
 * is one decision — which fields a cached enrichment carries into `applyMetadata` — and
 * both `enrichFacts` callers (the row-holding path replays through `persist`, the facts
 * path through the store) must agree on it by construction rather than by parallel code.
 */
import { READER_VERSION } from '@edge-sonic/media-tags';
import type { CachedEnrichment } from './songMetaCache';

interface CachedFactsMetadata {
  readonly duration: number;
  readonly bitrate: number;
  readonly readerVersion: number;
  readonly sampleRate?: number;
  readonly channels?: number;
}

/**
 * The `applyMetadata` patch a complete cache entry implies.
 *
 * A replayed row is still a write — measured, not declared — and a row already current
 * reports `0` by measurement: `applyMetadata` reports its own `changes`, so the caller
 * paces off what happened rather than what was attempted.
 */
function metadataFromCachedEnrichment(cached: CachedEnrichment): CachedFactsMetadata {
  return {
    duration: Math.max(0, Math.round(cached.durationSeconds ?? 0)),
    bitrate: cached.bitrateKbps === null ? 0 : Math.max(0, Math.round(cached.bitrateKbps)),
    readerVersion: READER_VERSION,
    ...(cached.sampleRate !== null && { sampleRate: cached.sampleRate }),
    ...(cached.channels !== null && { channels: cached.channels }),
  };
}

export { metadataFromCachedEnrichment };
export type { CachedFactsMetadata };
