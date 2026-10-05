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
 * during a flapping origin and reported duration `0` for ever.
 */
import type { LibraryRow, MetadataWriteResult, SongRow } from '@edge-sonic/backend-data/dao';
import { readAudioTags, readOggTailDuration, READER_VERSION } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { WebDavClient } from '@edge-sonic/webdav';
import { isTransientEnrichmentFailure, shouldEnrich } from './enrichmentRetry';

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
Cached enrichment, keyed by song id and validated by the file's mtime.
*/
interface CachedEnrichment {
  readonly mtimeMs: number;
  /**
   * Which reader produced this entry. Part of the entry rather than implied by it: an entry written
   * by a reader that could not read something a later reader can is not a value this reader may skip
   * a read for, and the mtime cannot say so — the file really did not move.
   */
  readonly readerVersion: number;
  readonly durationSeconds: number | null;
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly container: string;
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
    if (cached && cached.mtimeMs === song.mtime_ms && cached.readerVersion === READER_VERSION) {
      // Replay the cached result into D1 if the row lost it (a restored backup, or
      // a row written by a scan after the cache was populated). The reader version is
      // part of the entry for the same reason it is a column: a cached value is only
      // usable by the reader that produced it.
      if (song.enriched_at === null || song.reader_version !== READER_VERSION) {
        // Measured, not declared: a cached replay is still a `songs` write, and a scan that
        // restored a library from a backup replays one of these per track.
        const written = await this.persist(song, cached.durationSeconds, cached.bitrateKbps, cached.sampleRate, cached.channels, null);
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
   */
  public async enrichFacts(library: LibraryRow, facts: EnrichFacts, onRequest?: () => void): Promise<EnrichmentOutcome> {
    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [facts.id]);
    // A cache hit is `0` rows, not `1`, and that is why this reports rather than returning
    // tags: on a library already enriched by `getSong` this branch is the common one, and
    // reporting `1` would pace the scan off a write that never happened.
    if (cached && cached.mtimeMs === facts.mtimeMs && cached.readerVersion === READER_VERSION) return NO_ENRICHMENT_WRITTEN;
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
    // by design rather than by failure.
    const tail = tags.durationSeconds === null || tags.durationSeconds === undefined
      ? await this.resolveTailDuration(library, facts, tags, onRequest)
      : { duration: tags.durationSeconds, transient: false };
    // A transient tail failure leaves no trace either — not even the good prefix tags, for the
    // same permanence as the prefix case above. The next call does both reads again.
    if (tail.transient) return NO_ENRICHMENT_WRITTEN;
    const duration = tail.duration;

    const entry: CachedEnrichment = {
      mtimeMs: facts.mtimeMs,
      readerVersion: READER_VERSION,
      durationSeconds: duration,
      // The bitrate of a variable-bitrate file is `size × 8 ÷ duration`, so it needs the
      // duration first: computed here rather than in the reader, which was handed a
      // duration it then refused to use.
      bitrateKbps: duration !== null && duration > 0 && facts.size > 0 ? Math.round((facts.size * 8) / duration / 1000) : tags.bitrateKbps,
      sampleRate: tags.sampleRate,
      channels: tags.channels,
      container: tags.container,
    };
    // A cache write is best-effort and must not fail the call: D1 already holds
    // the result, which is what the outage requirement depends on.
    await this.deps.kv.putJson('songMeta', [facts.id], entry);
    await write(entry.durationSeconds, entry.bitrateKbps, entry.sampleRate, entry.channels, tags);
    return { tags, rowsWritten, billedRows };
  }

  /**
   * The duration of a container whose length is recorded at the **end** of the file.
   *
   * Best effort. `duration: null` is a real answer: a tail that does not contain the
   * final page leaves the duration unknown, and the row is written as `0`. That is the
   * honest value — the alternative is a confident wrong one, and a client seeks by it.
   * A 240.61 s track was served as 3 s and 15329 kbps instead of 191 because the prefix
   * read's truncated page was taken for the file's last.
   *
   * `transient: true` is the third answer and means "do not write": the tail read failed in a way
   * that says nothing about the file, so even the good prefix tags stay out of D1. A result object
   * rather than a `null`-or-sentinel union, because `null` is the *other* answer.
   */
  private async resolveTailDuration(
    library: LibraryRow,
    facts: EnrichFacts,
    tags: AudioTags,
    onRequest?: () => void,
  ): Promise<{ duration: number | null; transient: boolean }> {
    const tailBytes = this.deps.readTailBytes ?? 0;
    if ((tailBytes <= 0) || tags.sampleRate === null || facts.size === 0) return { duration: null, transient: false };
    // Only Ogg records its length this way. MP4 puts `moov` at the end and needs a
    // different parse, so this does not pretend to cover it.
    if (tags.container !== 'ogg-opus' && tags.container !== 'ogg-vorbis') return { duration: null, transient: false };

    try {
      const client = await this.deps.clientFor(library, onRequest);
      const bytes = await client.readTail(facts.path, tailBytes, facts.size, this.deps.timeoutMs);
      // The granule includes the pre-skip and the duration must not, and the pre-skip is
      // in the identification header at the *front* of the file — which the prefix read
      // already read, and which is why it is carried on `AudioTags` rather than re-read.
      return { duration: readOggTailDuration(bytes, tags.sampleRate, tags.preskip ?? 0), transient: false };
    } catch (error) {
      return { duration: null, transient: isTransientEnrichmentFailure(error) };
    }
  }

  /**
   * Write the result to D1.
   *
   * Text tags are only written when the file supplied them, so a format with no
   * comment block does not blank out metadata a previous read found — and, more
   * importantly, does not overwrite the path-convention fallback the indexer
   * derived.
   */
  private async persist(
    song: SongRow,
    duration: number | null,
    bitrate: number | null,
    sampleRate: number | null,
    channels: number | null,
    tags: AudioTags | null,
  ): Promise<MetadataWriteResult> {
    return await this.deps.songs.applyMetadata(song.id, {
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

}

export { EnrichmentService };
export { shouldEnrich } from './enrichmentRetry';
export type { EnrichmentDeps, CachedEnrichment, EnrichFacts, EnrichmentOutcome };
