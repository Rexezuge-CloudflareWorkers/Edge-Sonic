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
 * per track, and a 5,000-track library is 5,000 subrequests against a 1,000 limit.
 * Reading it on `getSong` costs **one subrequest per song the client actually
 * opens**, which is a handful per listening session rather than thousands.
 *
 * ### What it writes, and what it does not
 *
 * The result is written to D1 (`songs.duration`), not just cached, so it survives a
 * cold isolate and a KV outage. KV holds a copy keyed by the file's `mtime_ms` so a
 * repeat `getSong` skips the read.
 *
 * A format this module cannot read yields `null`, which is written as `0` and
 * **left alone on the next call** — see `shouldEnrich`.
 */
import { decryptData } from '@edge-sonic/backend-data/crypto';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { readAudioTags } from '@edge-sonic/media-tags';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { WebDavClient } from '@edge-sonic/webdav';

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
    },
  ): Promise<void>;
}

interface EnrichmentDeps {
  songs: SongStore;
  clientFor: (row: LibraryRow) => Promise<WebDavClient>;
  kv: KvCache;
  resolveKey: () => Promise<string>;
  /**
  Bytes read from the head of a file.
  */
  readBytes: number;
  timeoutMs: number;
}

/**
Cached enrichment, keyed by song id and validated by the file's mtime.
*/
interface CachedEnrichment {
  readonly mtimeMs: number;
  readonly durationSeconds: number | null;
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly container: string;
}

/**
 * A row worth another read.
 *
 * The guard is the mtime, not `duration = 0`. A row with `duration = 0` is either
 * *not yet read* or *unreadable by this module* — MP4/M4A puts `moov` at the end of
 * the file, so a prefix read cannot reach it. Retrying those on every `getSong`
 * would be one wasted subrequest per play, forever, for a format that needs a tail
 * read instead. So:
 *
 * - mtime moved → re-read (the file changed, it may be readable now);
 * - mtime unchanged and `enriched_at` is set → never read again;
 * - mtime unchanged and `enriched_at` is null → never scanned, read once.
 */
function shouldEnrich(song: SongRow): boolean {
  return song.enriched_at === null;
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
    if (song.enriched_at !== null && song.duration > 0) return null;

    const cached = await this.deps.kv.getJson<CachedEnrichment>('songMeta', [song.id]);
    if (cached && cached.mtimeMs === song.mtime_ms) {
      // Replay the cached result into D1 if the row lost it (a restored backup, or
      // a row written by a scan after the cache was populated).
      if (song.enriched_at === null) {
        await this.persist(song, cached.durationSeconds, cached.bitrateKbps, cached.sampleRate, cached.channels, null);
      }
      return null;
    }

    if (!shouldEnrich(song)) return null;

    let tags: AudioTags | null = null;
    try {
      const client = await this.deps.clientFor(library);
      const bytes = await client.readPrefix(song.path, this.deps.readBytes, this.deps.timeoutMs);
      tags = readAudioTags(bytes, song.size);
    } catch {
      // Recorded as an attempt so the next call does not retry a format this
      // server cannot read.
      await this.persist(song, null, null, null, null, null);
      return null;
    }

    if (tags === null || tags.container === 'unknown') {
      await this.persist(song, null, null, null, null, null);
      return null;
    }

    const entry: CachedEnrichment = {
      mtimeMs: song.mtime_ms,
      durationSeconds: tags.durationSeconds,
      bitrateKbps: tags.bitrateKbps,
      sampleRate: tags.sampleRate,
      channels: tags.channels,
      container: tags.container,
    };
    // A cache write is best-effort and must not fail the call: D1 already holds
    // the result, which is what the outage requirement depends on.
    await this.deps.kv.putJson('songMeta', [song.id], entry);
    await this.persist(song, entry.durationSeconds, entry.bitrateKbps, entry.sampleRate, entry.channels, tags);
    return tags;
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

  /**
   * Fill in title/artist/album for a row the indexer created from a path but never
   * enriched.
   *
   * Separate from `enrich` because the *derived* metadata is what `getArtists` and
   * `getAlbumList2` group by, and a library that has been browsed but not scanned
   * has rows with a path-derived title and no album at all. Callers use this when
   * they need a groupable row and are willing to spend a read.
   */
  public async ensureDerived(library: LibraryRow, song: SongRow): Promise<void> {
    if (song.title !== null || song.enriched_at !== null) return;
    const client = await this.deps.clientFor(library);
    try {
      const bytes = await client.readPrefix(song.path, this.deps.readBytes, this.deps.timeoutMs);
      const tags = readAudioTags(bytes, song.size);
      if (tags.container === 'unknown') return;
      await this.persist(song, tags.durationSeconds, tags.bitrateKbps, tags.sampleRate, tags.channels, tags);
    } catch {
      // Best effort by definition.
    }
  }

  /**
  Decrypt a library's WebDAV password. Exposed for the admin probe path.
  */
  public static async decryptLibraryPassword(row: LibraryRow, key: string): Promise<string> {
    return await decryptData(row.password_ciphertext, row.password_iv, key);
  }
}

export { EnrichmentService, shouldEnrich };
export type { EnrichmentDeps, CachedEnrichment };
