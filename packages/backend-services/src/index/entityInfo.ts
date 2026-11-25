/**
 * Album and artist info, re-derived from a track's tags and cached in KV.
 *
 * ### Why a service rather than endpoint code
 *
 * The four info endpoints ask two different questions over the same bytes: album notes and
 * a MusicBrainz album id, or an artist biography and a MusicBrainz artist id. One reader and
 * one cache behind all four is what keeps a client switching between `getAlbumInfo` and
 * `getAlbumInfo2` from getting two answers to one question.
 *
 * ### Nothing is written to D1
 *
 * An info read is not an index fact: it is a bounded ranged read of one file, cached in KV
 * under the file's own revision plus {@link INFO_READER_VERSION}. A rescan that finds nothing
 * new leaves the entry valid; a re-tagged file or a corrected reader makes it unreachable.
 * The cache is never load-bearing — a miss, an eviction or a throwing binding recomputes.
 *
 * ### The negative entry is written only when the look finished
 *
 * "No notes" is an ordinary answer and caching it keeps an untagged album from re-reading its
 * first track on every album screen. A failed read is not that answer: a `503` remembered as
 * "no biography" would survive every retry until the file moved or the entry aged out.
 */
import { INFO_READER_VERSION, readEmbeddedInfo } from '@edge-sonic/media-tags';
import type { EmbeddedInfo } from '@edge-sonic/media-tags';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { WebDavClient } from '@edge-sonic/webdav';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

const logger = createLogger('EntityInfo');

/**
 * Matches the tag reader's own prefix. FLAC and Ogg carry their comments at the front, and
 * an ID3 `COMM`/`TXXX` frame is walked from the tag header; a frame past the read reports no
 * info rather than a truncated sentence.
 */
const INFO_PREFIX_BYTES = 128 * 1024;

/**
 * The subset of a song row this module needs.
 *
 * Not `SongRow`: a fabricated full row is a copy of the schema that rots silently when a
 * column is added. `path` is the read target; `mtime_ms` and `size` are the revision in the
 * cache key.
 */
interface InfoSong {
  readonly path: string;
  readonly size: number;
  readonly mtime_ms: number;
}

interface EntityInfoDeps {
  readonly cache: KvCache;
  readonly clientFor: (library: LibraryRow) => Promise<WebDavClient>;
  readonly timeoutMs: number;
}

/**
 * The answer is the same object whether it came from the cache or the file, so the four
 * endpoints cannot disagree about where a field came from.
 */
type ResolvedInfo = EmbeddedInfo;

function infoKey(library: LibraryRow, song: InfoSong): string[] {
  return [library.id, song.path, `v${INFO_READER_VERSION}`, `${song.mtime_ms}x${song.size}`];
}

class EntityInfoService {
  constructor(private readonly deps: EntityInfoDeps) {}

  /**
   * The info in one track's tags, or all fields absent.
   *
   * A read that threw returns all fields absent but caches nothing — indistinguishable to
   * the caller, which is the point: an info panel with nothing in it is better than a failed
   * request, but it must not become a 30-day claim about the file.
   */
  public async forSong(library: LibraryRow, song: InfoSong): Promise<ResolvedInfo> {
    const key = infoKey(library, song);
    const cached = await this.deps.cache.getJson<ResolvedInfo>('entityInfo', key);
    if (cached !== null) return cached;

    let bytes: Uint8Array;
    try {
      const client = await this.deps.clientFor(library);
      bytes = await client.readPrefix(song.path, INFO_PREFIX_BYTES, this.deps.timeoutMs);
    } catch (error) {
      logger.warn(`Info unreadable for ${song.path}: ${error instanceof Error ? error.message : String(error)}`);
      return { notes: null, albumMusicBrainzId: null, artistMusicBrainzId: null };
    }
    const info = readEmbeddedInfo(bytes) ?? { notes: null, albumMusicBrainzId: null, artistMusicBrainzId: null };
    await this.deps.cache.putJson('entityInfo', key, info);
    return info;
  }
}

export { EntityInfoService, INFO_PREFIX_BYTES, infoKey };
export type { EntityInfoDeps, InfoSong, ResolvedInfo };
