/**
 * What a `songMeta` cache entry holds, and the one question asked about it.
 *
 * ### Why this is its own module
 *
 * The entry's **shape** and the **completeness test** are one decision, and they were
 * both inside `EnrichmentService`, which is why the completeness rule went in without
 * being read next to the shape it is about: a cache entry recording `durationSeconds:
 * null` is not an answer, and nothing about the type says so.
 *
 * It is also the third thing that answers "has this file already been read?", so it
 * belongs beside the other two rather than inside the service that happens to consult it:
 * `shouldEnrich` asks it of a **row** (`enrichmentRetry.ts`), and this asks it of a
 * **cache entry**, and both must say yes for the same file or one of the two is stale.
 * `EnrichmentService` consults the cache *before* the row, so an entry that disagreed
 * with the row's own stamp would decide the answer alone.
 */

import { READER_VERSION } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';

/**
 * Cached enrichment, keyed by song id and validated by the file's mtime.
 *
 * The text tags ride along with the technical facts, and that is load-bearing
 * rather than convenient: a replayed row is still a write, and a replay that
 * carries only the duration strands a row whose tags were lost (an index drop
 * deletes `songs` but not this cache, and a re-index recreates the row with
 * path-derived names under the same id and mtime). Such a row then reports the
 * folder's sanitized spelling — `Avid _ Hands Up to the Sky` for `Avid /
 * Hands Up to the Sky`, where `/` cannot live in a folder name — with a
 * correct duration, stamped current, and never re-read. The tags are optional
 * so an entry for a genuinely untagged file stays what it is: a file with no
 * tags is not a file whose tags are unknown, and replaying nothing for it
 * leaves the derived fallback it already holds.
 */
interface CachedEnrichment {
  readonly mtimeMs: number;
  /**
   * Which reader produced this entry. Part of the entry rather than implied by it: an
   * entry written by a reader that could not read something a later reader can is not a
   * value this reader may skip a read for, and the mtime cannot say so — the file really
   * did not move.
   */
  readonly readerVersion: number;
  readonly durationSeconds: number | null;
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly container: string;
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
 * Whether a `songMeta` entry is an **answer**, rather than an absence recorded as one.
 *
 * ### Why `null` is not an answer
 *
 * A cached entry exists so the next `getSong` can skip a read. An entry whose
 * `durationSeconds` is `null` skips a read to produce `null` again — and it does so
 * *forever*, because the entry matches on `mtimeMs` and `readerVersion`, neither of
 * which changes when the thing that made it null goes away. For an Ogg library that is
 * not hypothetical: the prefix read reports no duration **by design** and only the tail
 * read supplies one, so a tail that was refused — or a deployment running with
 * `TAG_READ_TAIL_BYTES=0` — wrote an entry that permanently answered "no duration" for
 * that file's mtime. Raising the setting afterwards changed nothing, because the entry
 * still matched.
 *
 * That is the negative-cache defect from `docs/agents/media/AGENTS.md` — *"we looked and
 * there is nothing" versus "we could not look"* — in the one cache whose entries are
 * written **before** anybody knows whether the answer is complete.
 *
 * ### Why both the writer and the reader ask
 *
 * The writer does not produce one, and the reader does not trust one. Only the second
 * half repairs a deployment that already holds the first's output: an entry written
 * before this rule existed still matches, and nothing else would ever invalidate it — a
 * `reader_version` bump happens by hand, and only on the next change to the reader.
 *
 * ### And the tags in such an entry are still real
 *
 * The incompleteness is `durationSeconds` alone. A file whose comment block was read
 * from the prefix and whose duration was not resolved is the **most** enriched row there
 * is — the artist, album and genre are there — so the row is written in full and only the
 * cache declines to remember it. Discarding the whole result would throw away a correct
 * answer to make room for a retry of the one value that is missing.
 */
function isCompleteEnrichment(entry: CachedEnrichment): boolean {
  return entry.durationSeconds !== null && entry.durationSeconds > 0;
}

/**
 * The cache entry for one successful read.
 *
 * Built here rather than inline in `EnrichmentService` because the shape and the
 * completeness test are one decision, and the entry is the third leg of it: what
 * is remembered decides what a replay can restore. The bitrate needs the resolved
 * duration first (`size × 8 ÷ duration` for a variable-bitrate file), so it is
 * computed here rather than in the reader, which was handed a duration it then
 * refused to use.
 *
 * Absent tags stay absent: `?? null` normalizes `undefined` (a reader that found
 * no comment block) to the same "no tag" the row already holds, and the persist
 * layer writes only truthy tags either way.
 */
function buildCacheEntry(mtimeMs: number, size: number, tags: AudioTags, duration: number | null): CachedEnrichment {
  return {
    mtimeMs,
    readerVersion: READER_VERSION,
    durationSeconds: duration,
    bitrateKbps: duration !== null && duration > 0 && size > 0 ? Math.round((size * 8) / duration / 1000) : tags.bitrateKbps,
    sampleRate: tags.sampleRate,
    channels: tags.channels,
    container: tags.container,
    title: tags.title ?? null,
    artist: tags.artist ?? null,
    album: tags.album ?? null,
    albumArtist: tags.albumArtist ?? null,
    genre: tags.genre ?? null,
    year: tags.year ?? null,
    track: tags.track ?? null,
    disc: tags.disc ?? null,
  };
}

export { isCompleteEnrichment, buildCacheEntry };
export type { CachedEnrichment };