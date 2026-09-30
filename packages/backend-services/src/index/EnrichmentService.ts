/**
 * Lazy tag enrichment: fill in `duration`, `bitrate`, and text tags for a song.
 *
 * ### Why it is lazy
 *
 * WebDAV cannot report a track's length. `PROPFIND` gives `getcontentlength`,
 * `getlastmodified` and `getcontenttype`, and a Subsonic client that knows a
 * track's duration draws a scrubber — so `duration` is effectively a required
 * field, and it is not in the filesystem's vocabulary.
 *
 * Reading it from every file during the scan is not affordable: one ranged read
 * per track, and a 5,000-track library is 5,000 subrequests against a per-invocation
 * ceiling that is 50 external on the Free plan. So it is read from two places, and
 * both are bounded — the scan, for the tracks it changed (see `scanEnrichment.ts`),
 * and `getSong`, for the rest, at the cost of one subrequest per song the client
 * actually opens.
 *
 * ### The second read
 *
 * A container whose length is recorded at the *end* of the file cannot be read from a
 * prefix. Ogg is the case: its granule position is in the final page's header. So a
 * prefix read reports no duration, and one tail-anchored read resolves it — reusing the
 * sample rate, channels and pre-skip the prefix read already established, so it is a
 * second range over the same file rather than a second parse of it.
 *
 * A deployment that does not configure `readTailBytes` gets no Ogg duration. That is the
 * intended trade: `null` is a value, and a wrong one is worse, because a client seeks by
 * it.
 *
 * ### What it writes, and what it does not
 *
 * The result is written to D1 (`songs.duration`), not just cached, so it survives a
 * cold isolate and a KV outage. KV holds a copy keyed by the file's `mtime_ms` so a
 * repeat `getSong` skips the read.
 *
 * A format this module cannot read yields `null`, which is written as `0` and
 * **left alone on the next call** — see `shouldEnrich`.
 *
 * A failure that says nothing about the file is never written at all. A `503`, a
 * timeout, or a reset connection is an answer about the network, and stamping
 * `enriched_at` over one makes a transient fault permanent: the row reports duration
 * `0` for ever, because `shouldEnrich` treats the stamp as "already read" and no
 * later call re-reads it. It shipped — four tracks of a live library were stamped
 * empty during a flapping origin and stayed at duration `0` through every `getSong`
 * after it. See `isTransientEnrichmentFailure`.
 */
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { readAudioTags, readOggTailDuration, READER_VERSION } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { WebDavClient } from '@edge-sonic/webdav';
import { isTransientEnrichmentFailure, shouldEnrich } from './enrichmentRetry';

interface SongStore {
  findById(id: string): Promise<SongRow | null>;
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
  ): Promise<void>;
}

interface EnrichmentDeps {
  songs: SongStore;
  /**
   * The optional second argument is a caller's request meter, forwarded to the
   * client so a range read is charged to the caller's budget. The scan passes one
   * because its range reads happen inside the folder walk, and they are the reads
   * that took a chunk from 40 subrequests to 1,640.
   */
  clientFor: (row: LibraryRow, onRequest?: () => void) => Promise<WebDavClient>;
  kv: KvCache;
  resolveKey: () => Promise<string>;
  /**
  Bytes read from the head of a file.
  */
  readBytes: number;
  /**
  Bytes read from the end of a file, for the duration of a container whose length is
  only recorded there.

  Optional, and defaulted: a deployment that leaves it unset gets no duration for Ogg
  rather than a wrong one, which is the same trade `readOggTailDuration` makes.
  */
  readTailBytes?: number;
  timeoutMs: number;
}

/**
 * What a range read needs, and nothing else.
 *
 * Deliberately not a `SongRow`: a caller without a row in hand — the scan, holding the
 * facts it just upserted — passes these four fields instead of fabricating a row to
 * satisfy a signature.
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
   * Which reader produced this entry.
   *
   * Part of the entry rather than implied by it: an entry written by a reader that could
   * not read something a later reader can is not a value this reader may skip a read
   * for, and the mtime cannot say so — the file really did not move.
   */
  readonly readerVersion: number;
  readonly durationSeconds: number | null;
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly container: string;
}


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
    if (song.enriched_at !== null && song.duration > 0 && song.reader_version === READER_VERSION) return null;

    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [song.id]);
    if (cached && cached.mtimeMs === song.mtime_ms && cached.readerVersion === READER_VERSION) {
      // Replay the cached result into D1 if the row lost it (a restored backup, or
      // a row written by a scan after the cache was populated). The reader version is
      // part of the entry for the same reason it is a column: a cached value is only
      // usable by the reader that produced it.
      if (song.enriched_at === null || song.reader_version !== READER_VERSION) {
        await this.persist(song, cached.durationSeconds, cached.bitrateKbps, cached.sampleRate, cached.channels, null);
      }
      return null;
    }

    if (!shouldEnrich(song)) return null;

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
  public async enrichFacts(library: LibraryRow, facts: EnrichFacts, onRequest?: () => void): Promise<AudioTags | null> {
    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [facts.id]);
    if (cached && cached.mtimeMs === facts.mtimeMs && cached.readerVersion === READER_VERSION) return null;
    return await this.readAndPersist(library, null, facts, onRequest);
  }

  /**
   * The one read path: a prefix read, an optional tail read, then D1 and KV.
   *
   * `row` is `null` when the caller has no row to write metadata through — the scan
   * writes by id, which is all a freshly upserted row needs.
   */
  private async readAndPersist(library: LibraryRow, row: SongRow | null, facts: EnrichFacts, onRequest?: () => void): Promise<AudioTags | null> {
    const write = async (
      duration: number | null,
      bitrate: number | null,
      sampleRate: number | null,
      channels: number | null,
      tags: AudioTags | null,
    ): Promise<void> => {
      if (row !== null) {
        await this.persist(row, duration, bitrate, sampleRate, channels, tags);
        return;
      }
      await this.deps.songs.applyMetadata(facts.id, {
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
    };

    let tags: AudioTags | null = null;
    try {
      const client = await this.deps.clientFor(library, onRequest);
      const bytes = await client.readPrefix(facts.path, this.deps.readBytes, this.deps.timeoutMs);
      tags = readAudioTags(bytes, facts.size);
    } catch (error) {
      // Recorded as an attempt so the next call does not retry a file this
      // server cannot read — but only when the failure *is* about the file.
      // A transient one leaves the row exactly as it found it, because stamping
      // `enriched_at` over a `503` is what made four tracks of a live library
      // report duration `0` for ever: the stamp said "already read", and nothing
      // ever re-read them.
      if (isTransientEnrichmentFailure(error)) return null;
      await write(null, null, null, null, null);
      return null;
    }

    if (tags === null || tags.container === 'unknown') {
      await write(null, null, null, null, null);
      return null;
    }

    // The prefix read cannot see the final page of an Ogg stream, so `durationSeconds`
    // is null there by design rather than by failure. One tail-anchored read resolves
    // it, reusing the sample rate and pre-skip the prefix read already established.
    const tail = tags.durationSeconds === null || tags.durationSeconds === undefined
      ? await this.resolveTailDuration(library, facts, tags, onRequest)
      : { duration: tags.durationSeconds, transient: false };
    // A tail read that failed transiently leaves no trace either — not even the good
    // prefix tags. Writing them would stamp the row and strand the duration at `0`
    // with the same permanence as the prefix case above; the next call simply does
    // both reads again, which is one extra prefix read against a retry that works.
    if (tail.transient) return null;
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
    return tags;
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
   * `transient: true` is the third answer, and it means "do not write": the tail read
   * failed in a way that says nothing about the file, so even the good prefix tags stay
   * out of D1 — writing them would stamp the row and strand the duration at `0`. A
   * result object rather than a `null`-or-sentinel union, because `null` is the *other*
   * answer and the two must not merge.
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
  ): Promise<void> {
    await this.deps.songs.applyMetadata(song.id, {
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
export type { EnrichmentDeps, CachedEnrichment, EnrichFacts };
