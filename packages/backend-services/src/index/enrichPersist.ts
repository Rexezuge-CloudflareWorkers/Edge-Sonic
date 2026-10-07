/**
 * Writing an enrichment result to D1.
 *
 * Own module rather than a private method on `EnrichmentService` because that file is over
 * the god-file limit and this is the block that does not belong: the column mapping — which
 * tags a file may overwrite and what an unreadable value becomes — is one decision, and the
 * two callers (the row-holding path and the facts path's inline writer) must agree on it by
 * construction rather than by parallel objects.
 */
import { READER_VERSION } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { MetadataWriteResult } from '@edge-sonic/backend-data/dao';

type ApplyMetadata = (
  id: string,
  metadata: {
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    albumArtist?: string | null;
    genre?: string | null;
    track?: number | null;
    disc?: number | null;
    year?: number | null;
    duration?: number | null;
    bitrate?: number | null;
    sampleRate?: number | null;
    channels?: number | null;
    readerVersion?: number | null;
  },
) => Promise<MetadataWriteResult>;

/**
 * Write the result to D1.
 *
 * Text tags are only written when the file supplied them, so a format with no comment
 * block does not blank out metadata a previous read found — and, more importantly, does
 * not overwrite the path-convention fallback the indexer derived.
 */
async function persistEnrichment(
  applyMetadata: ApplyMetadata,
  songId: string,
  duration: number | null,
  bitrate: number | null,
  sampleRate: number | null,
  channels: number | null,
  tags: AudioTags | null,
): Promise<MetadataWriteResult> {
  return await applyMetadata(songId, {
    // `duration` and `bitrate` are NOT NULL columns, so an unreadable value is
    // 0 rather than null.
    duration: duration === null ? 0 : Math.max(0, Math.round(duration)),
    bitrate: bitrate === null ? 0 : Math.max(0, Math.round(bitrate)),
    // Stamped even when every tag is null and only the "we tried" part of this write
    // matters. A row that records the attempt must also record *who* attempted it, or
    // the next reader has no way to tell a deliberate skip from a stale one.
    readerVersion: READER_VERSION,
    ...(sampleRate !== null && { sampleRate }),
    ...(channels !== null && { channels }),
    ...(tags && {
      ...(tags.title && { title: tags.title }),
      ...(tags.artist && { artist: tags.artist }),
      ...(tags.album && { album: tags.album }),
      ...(tags.albumArtist && { albumArtist: tags.albumArtist }),
      ...(tags.genre && { genre: tags.genre }),
      ...(tags.track !== null && { track: tags.track }),
      ...(tags.disc !== null && { disc: tags.disc }),
      ...(tags.year !== null && { year: tags.year }),
    }),
  });
}

export { persistEnrichment };
