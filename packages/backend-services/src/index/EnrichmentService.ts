/**
 * Lazy tag enrichment: fill in `duration`, `bitrate`, and text tags for a song.
 *
 * WebDAV cannot report a track's length — `PROPFIND` gives `getcontentlength`,
 * `getlastmodified` and `getcontenttype`, and a client that knows a track's duration draws a
 * scrubber. Reading it from every file during a scan is not affordable: one ranged read per
 * track, and 5,000 tracks is 5,000 subrequests against a ceiling of 50. So it is read from two
 * bounded places — the scan, for the tracks it changed (`scanEnrichment.ts`), and `getSong` for
 * the rest.
 *
 * A container whose length lives at the **end** of the file cannot be read from a prefix; Ogg is
 * the case, its granule position being in the final page's header. One tail-anchored read
 * resolves it — see `readTailBytes` and `resolveTailDuration`.
 *
 * ### What it writes, and what it does not
 *
 * D1, not just the cache, so the result survives a cold isolate and a KV outage. KV holds a copy
 * keyed by the file's `mtime_ms` **and the reader version**, because an entry written by a reader
 * that could not read something a later reader can is not a value this reader may skip a read for.
 *
 * A format this module cannot read yields `null`, written as `0` and **left alone on the next
 * call** (`shouldEnrich`). A failure that says nothing about the file is never written at all: a
 * `503`, a timeout or a reset is an answer about the network, and stamping `enriched_at` over
 * one makes the fault permanent, because `shouldEnrich` reads the stamp as "already read" and no
 * later call re-reads the row. It shipped — four tracks of a live library were stamped empty
 * during a flapping origin and reported duration `0` for ever — and then it shipped again with a
 * different status: `413` is **this server's own body bound**, which an origin that answers a
 * `Range` request with the whole file trips on every track, so one such origin stamped an entire
 * library "read" without reading any of it. The rule is in `enrichmentRetry.ts` and it is one
 * question: does this failure describe the file, or the request?
 *
 * The cache carries the same discipline in the other direction, and lives in
 * `songMetaCache.ts`: an entry exists to skip a read, and an entry recording "no duration"
 * skips a read to produce `null` again for as long as the file does not move — which for an
 * Ogg file is every future `getSong`.
 */
import type { LibraryRow, MetadataWriteResult, SongRow } from '@edge-sonic/backend-data/dao';
import { readAudioTags, READER_VERSION } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { WebDavClient } from '@edge-sonic/webdav';
import { isTransientEnrichmentFailure, shouldEnrich } from './enrichmentRetry';
import { isCompleteEnrichment, buildCacheEntry } from './songMetaCache';
import type { CachedEnrichment } from './songMetaCache';
import { metadataFromCachedEnrichment, tagsFromCachedEnrichment } from './enrichCacheReplay';
import { persistEnrichment } from './enrichPersist';
import { resolveTailDuration } from './oggTailDuration';
import type { TailDuration } from './oggTailDuration';

interface SongStore {
  findById(id: string): Promise<SongRow | null>;
  /**
   * Writes the patch and reports what it cost against the daily row-write allowance.
   *
   * A measurement rather than `void`: it was `void`, so this module hardcoded `rowsWritten = 1`,
   * and a `songs` write bills ten rows.
   */
  applyMetadata(
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
      /**
       * Which version of the tag reader produced this write. Written with the values
       * rather than beside them, because a row whose `enriched_at` moved without its
       * `reader_version` is a row no future reader can tell apart from a current one.
       */
      readerVersion?: number | null;
    },
  ): Promise<MetadataWriteResult>;
}

interface EnrichmentDeps {
  songs: SongStore;
  /**
   * The optional second argument is a caller's request meter, forwarded to the client so a range read
   * is charged to the caller's budget. The scan passes one because its range reads happen inside the
   * folder walk — the reads that took a chunk from 40 subrequests to 1,640.
   */
  clientFor: (row: LibraryRow, onRequest?: () => void) => Promise<WebDavClient>;
  kv: KvCache;
  resolveKey: () => Promise<string>;
  /**
  Bytes read from the head of a file.
  */
  readBytes: number;
  /**
  Bytes read from the end of a file, for a container whose length is only recorded there.
  Optional: unset means no duration for Ogg rather than a wrong one.
  */
  readTailBytes?: number;
  timeoutMs: number;
}

/**
 * What a range read needs, and nothing else.
 *
 * Deliberately not a `SongRow`: a caller without a row in hand — the scan, holding the facts it
 * just upserted — passes these four fields rather than fabricating a row to satisfy a signature.
 */
interface EnrichFacts {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * What an enrichment actually did, as distinct from what it found.
 *
 * `rowsWritten` is rows **written to `songs`**, not tracks asked about, and the two differ: a
 * `songMeta` cache hit returns without touching D1, a transient failure does too — deliberately, so
 * a flapping origin does not stamp the row — and an unknown container writes one row recording the
 * attempt. Counting "enriched" would report all three alike, and pace the scan off writes that never
 * happened.
 *
 * `billedRows` is what those rows cost against D1's daily allowance, and it exists because
 * `applyMetadata` returned `void`: the only figure available was then the literal `1`, and the guard
 * this feeds was short by a factor of ten on this path. `scanAccounting` owns the two-count
 * arrangement and why the platform's unit is not a row.
 */
interface EnrichmentOutcome {
  /**
   * The tags read out of the file, or `null` for an unreadable container, a transient failure and a
   * cache hit alike — indistinguishable to a caller wanting only tags, hence the counts beside it.
   */
  readonly tags: AudioTags | null;
  /**
  Rows changed: `1` per path that reached `applyMetadata` and matched; `0` for the two above.
  */
  readonly rowsWritten: number;
  /**
  What they cost the platform. `0` exactly when `rowsWritten` is `0`, else a multiple of it.
  */
  readonly billedRows: number;
}

/**
 * An outcome for a call that wrote nothing, so "wrote nothing" is one value: the paths that
 * short-circuit before any read — a cache hit, and a row already current — are the same answer
 * to the only question the counter asks.
 */
const NO_ENRICHMENT_WRITTEN: EnrichmentOutcome = { tags: null, rowsWritten: 0, billedRows: 0 };

class EnrichmentService {
  constructor(private readonly deps: EnrichmentDeps) {}

  /**
   * Return the song's tags, reading them if this is the first time.
   *
   * Never throws for a content problem: a truncated read, an unknown container, or
   * a WebDAV error all resolve to "no enrichment", because a `getSong` that fails
   * because it could not read a duration is worse than one that reports `0`.
   */
  public async enrich(library: LibraryRow, song: SongRow): Promise<AudioTags | null> {
    return (await this.enrichReporting(library, song)).tags;
  }

  /**
   * `enrich`, reporting the row it wrote.
   *
   * The outcome-carrying twin rather than a widened `enrich`, and the split is by
   * **caller**: `getSong` wants tags and reads nothing else, while the scan's budget
   * wants the row count and infers nothing. One implementation, two projections — `enrich`
   * is a delegation rather than a second copy of the decision tree above it, because a
   * second copy is free to disagree about when a row is replayed from cache.
   */
  public async enrichReporting(library: LibraryRow, song: SongRow): Promise<EnrichmentOutcome> {
    if (song.enriched_at !== null && song.duration > 0 && song.reader_version === READER_VERSION) return NO_ENRICHMENT_WRITTEN;

    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [song.id]);
    if (cached && cached.mtimeMs === song.mtime_ms && cached.readerVersion === READER_VERSION && isCompleteEnrichment(cached)) {
      // Replay the cached result into D1 if the row lost it (a restored backup, or
      // a row written by a scan after the cache was populated). The reader version is
      // part of the entry for the same reason it is a column: a cached value is only
      // usable by the reader that produced it. The tags replay with the technical
      // facts for the same reason they are cached with them: a row recreated after
      // the read (an index drop deletes `songs` but not this cache) holds
      // path-derived names, and replaying only the duration would stamp those
      // guesses current — a sanitized folder spelling with a correct duration,
      // never re-read.
      if (song.enriched_at === null || song.reader_version !== READER_VERSION) {
        // Measured, not declared: a cached replay is still a `songs` write, and a scan that
        // restored a library from a backup replays one of these per track.
        const written = await this.persist(song, cached.durationSeconds, cached.bitrateKbps, cached.sampleRate, cached.channels, tagsFromCachedEnrichment(cached));
        return { tags: null, rowsWritten: written.changes, billedRows: written.billedRows };
      }
      return NO_ENRICHMENT_WRITTEN;
    }

    if (!shouldEnrich(song)) return NO_ENRICHMENT_WRITTEN;

    return await this.readAndPersist(library, song, { id: song.id, path: song.path, size: song.size, mtimeMs: song.mtime_ms });
  }

  /**
   * Enrich a track from its file facts, without a `songs` row in hand.
   *
   * The scan calls this. It exists so the scan does not have to fabricate a `SongRow` to
   * satisfy a signature — a fabricated row is a copy of the schema that silently rots
   * when a column is added, and the failure is a wrong answer rather than a type error.
   * Both entry points share `readAndPersist`, so a track enriched by a scan and a track
   * enriched on first play are enriched identically.
   *
   * A cache hit replays the entry into D1 rather than returning without writing, like the
   * row-holding entry point does: the facts caller has no row to compare against, so a hit
   * here means the row lost what the cache still holds (a restored backup, or a row
   * written after the cache was populated) — and returning without writing would leave the
   * row unstamped, re-selected by every future page, for ever. Measured, not declared: the
   * replay is still a `songs` write.
   */
  public async enrichFacts(library: LibraryRow, facts: EnrichFacts, onRequest?: () => void): Promise<EnrichmentOutcome> {
    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [facts.id]);
    // A replayed row is still a write: on a library already enriched by `getSong` the common
    // case is a row that already holds what the cache holds, and `applyMetadata` reports its
    // own `changes`, so a current row reports `0` by measurement rather than by declaration.
    if (cached && cached.mtimeMs === facts.mtimeMs && cached.readerVersion === READER_VERSION && isCompleteEnrichment(cached)) {
      const written = await this.deps.songs.applyMetadata(facts.id, metadataFromCachedEnrichment(cached));
      return { tags: null, rowsWritten: written.changes, billedRows: written.billedRows };
    }
    return await this.readAndPersist(library, null, facts, onRequest);
  }

  /**
   * The one read path: a prefix read, an optional tail read, then D1 and KV.
   *
   * `row` is `null` when the caller has no row to write metadata through — the scan
   * writes by id, which is all a freshly upserted row needs.
   */
  private async readAndPersist(library: LibraryRow, row: SongRow | null, facts: EnrichFacts, onRequest?: () => void): Promise<EnrichmentOutcome> {
    // Counted by the closure rather than by its callers, because `write` is the only place in
    // the service that issues an `UPDATE`, and every answer about rows written has to be the same
    // answer.
    //
    // A **measurement**, taken from the statement's own result rather than declared as `1` once
    // entered — this `UPDATE` bills ten rows, and the budget the scan paces itself against is
    // denominated in exactly those.
    let rowsWritten = 0;
    let billedRows = 0;
    const write = async (
      duration: number | null,
      bitrate: number | null,
      sampleRate: number | null,
      channels: number | null,
      tags: AudioTags | null,
    ): Promise<void> => {
      if (row !== null) {
        ({ changes: rowsWritten, billedRows } = await this.persist(row, duration, bitrate, sampleRate, channels, tags));
        return;
      }
      const written = await this.deps.songs.applyMetadata(facts.id, {
        duration: duration === null ? 0 : Math.max(0, Math.round(duration)),
        bitrate: bitrate === null ? 0 : Math.max(0, Math.round(bitrate)),
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
      rowsWritten = written.changes;
      billedRows = written.billedRows;
    };

    let tags: AudioTags | null = null;
    try {
      const client = await this.deps.clientFor(library, onRequest);
      const bytes = await client.readPrefix(facts.path, this.deps.readBytes, this.deps.timeoutMs);
      tags = readAudioTags(bytes, facts.size);
    } catch (error) {
      // Recorded as an attempt so the next call does not retry a file this server cannot read —
      // but only when the failure *is* about the file. A transient one leaves the row as it found
      // it; the module header carries what stamping `enriched_at` over a `503` cost.
      if (isTransientEnrichmentFailure(error)) return NO_ENRICHMENT_WRITTEN;
      await write(null, null, null, null, null);
      return { tags: null, rowsWritten, billedRows };
    }

    if (tags === null || tags.container === 'unknown') {
      await write(null, null, null, null, null);
      return { tags: null, rowsWritten, billedRows };
    }

    // The prefix read cannot see an Ogg stream's final page, so `durationSeconds` is null there
    // by design rather than by failure — which is what sends it to the second read.
    //
    // `tags.durationSeconds === undefined` is included because the reader's field is
    // optional, and `undefined` is not `null`: an MP3 read that found no Xing frame would
    // otherwise skip the tail read and be written with no duration and no attempt to get
    // one.
    const tail = tags.durationSeconds === null || tags.durationSeconds === undefined
      ? await this.tailDuration(library, facts, tags, onRequest)
      : { duration: tags.durationSeconds, transient: false };
    // A transient tail failure leaves no trace either — not even the good prefix tags, for the
    // same permanence as the prefix case above. The next call does both reads again.
    if (tail.transient) return NO_ENRICHMENT_WRITTEN;
    const duration = tail.duration;

    const entry: CachedEnrichment = buildCacheEntry(facts.mtimeMs, facts.size, tags, duration);
    // Only a **complete** read is cached, and the incompleteness is not the container's
    // fault: `resolveTailDuration` answers `null` for a container it cannot date, and also
    // for one whose duration it was not allowed to read. Caching the first would trade a
    // retry for a permanent wrong answer about a file that never moved — see
    // `isCompleteEnrichment`.
    //
    // Losing the cache here costs nothing measurable. The row is stamped either way, so
    // `enrich` never reaches this path for it again; and a row that is *not* stamped is
    // re-read, which is what an unstamped row is for.
    //
    // A cache write is best-effort and must not fail the call: D1 already holds
    // the result, which is what the outage requirement depends on.
    if (isCompleteEnrichment(entry)) await this.deps.kv.putJson('songMeta', [facts.id], entry);
    await write(entry.durationSeconds, entry.bitrateKbps, entry.sampleRate, entry.channels, tags);
    return { tags, rowsWritten, billedRows };
  }

  /**
   * The second read, for a container whose length is recorded at the **end** of the file.
   *
   * Thin delegation to `oggTailDuration.ts`, which owns the three answers and the
   * distinction between them. The one thing owned here is the client — which the caller's
   * request meter is threaded into, so a tail read is charged against the same subrequest
   * ceiling as the `PROPFIND` that found the file.
   */
  private async tailDuration(
    library: LibraryRow,
    facts: EnrichFacts,
    tags: AudioTags,
    onRequest?: () => void,
  ): Promise<TailDuration> {
    const client = await this.deps.clientFor(library, onRequest);
    return await resolveTailDuration(client, facts, tags, this.deps.readTailBytes, this.deps.timeoutMs);
  }

  private async persist(
    song: SongRow,
    duration: number | null,
    bitrate: number | null,
    sampleRate: number | null,
    channels: number | null,
    tags: AudioTags | null,
  ): Promise<MetadataWriteResult> {
    return await persistEnrichment(
      (id, metadata) => this.deps.songs.applyMetadata(id, metadata),
      song.id,
      duration,
      bitrate,
      sampleRate,
      channels,
      tags,
    );
  }

}

export { EnrichmentService };
export { shouldEnrich } from './enrichmentRetry';
export type { EnrichmentDeps, EnrichFacts, EnrichmentOutcome };
// Re-exported so the entry's shape and the test about it have one import path, and so a
// caller that built one by hand keeps the module that decides whether it is usable.
export { isCompleteEnrichment, buildCacheEntry } from './songMetaCache';
export type { CachedEnrichment } from './songMetaCache';
