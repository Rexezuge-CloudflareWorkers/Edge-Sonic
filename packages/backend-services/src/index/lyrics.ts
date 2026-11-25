/**
 * Lyrics: a sidecar file first, the track's own tags second.
 *
 * ### The precedence, and why it is not the obvious one
 *
 * A `.lrc` sidecar is **synced** — it carries millisecond offsets — while a tag is usually
 * a block of plain text. A track that has both is better served by the sidecar, because
 * `getLyricsBySongId` is the endpoint a modern client draws a scrolling panel from, and an
 * embedded unsynced string gives it nothing to scroll against. `.txt` comes next, then the
 * tags: a plain sidecar is easier for an operator to edit than a retagged file, and it is
 * the thing they added deliberately.
 *
 * ### Nothing is written to D1
 *
 * Like artwork, a lyric is re-derived from the origin and cached in KV. A `getLyrics` call
 * is on every track a client opens, so the cost that matters is a cold read: one D1 read
 * to find the folder's children (or one `PROPFIND` if the folder was never materialized),
 * then one ranged read for the sidecar or the audio file. The KV key carries the song's
 * and the sidecar's revisions plus {@link LYRICS_READER_VERSION}, so a re-tagged file or a
 * corrected reader makes the entry unreachable rather than stale.
 *
 * ### The negative entry is written only when the look actually finished
 *
 * An entry saying "no lyrics" is what keeps an instrumental from re-reading its folder on
 * every play. But it is a 30-day claim, and a transient origin failure is not an answer:
 * a `503` that was cached as "no lyrics" would survive every retry until the file moved or
 * the entry aged out. So a read that threw — or a folder listing that failed, which leaves
 * the sidecar question unanswered — returns the best answer available and caches nothing.
 */
import { LYRICS_READER_VERSION, decodeLyricsText, parseLyricsText, readEmbeddedLyrics } from '@edge-sonic/media-tags';
import type { LyricsLine } from '@edge-sonic/media-tags';
import type { LibraryRow, NodeRow } from '@edge-sonic/backend-data/dao';
import type { WebDavClient } from '@edge-sonic/webdav';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

const logger = createLogger('Lyrics');

/**
 * How much of a file to read when looking for embedded lyrics.
 *
 * 128 KiB matches the tag reader's own prefix. FLAC and Ogg keep their comment blocks at
 * the front, and an ID3 tag that size holds far more lyric text than a song has; a `USLT`
 * frame past the read reports no lyrics rather than a truncated line.
 */
const LYRICS_PREFIX_BYTES = 128 * 1024;

/**
 * How much of a sidecar to read. A lyric file is text, and this is a bound on a hostile
 * length rather than a policy limit — 64 KiB is thousands of lines.
 */
const LYRICS_SIDECAR_BYTES = 64 * 1024;

/**
 * The subset of a song row this module needs.
 *
 * Not `SongRow`: a fabricated full row is a copy of the schema that rots silently when a
 * column is added. Every field here is load-bearing — `dir_path` finds the sidecars,
 * `path`/`name` read the track and match the sidecar's stem, and the revision pair is in
 * the cache key.
 */
interface LyricsSong {
  readonly id: string;
  readonly path: string;
  readonly dir_path: string;
  readonly name: string;
  readonly size: number;
  readonly mtime_ms: number;
}

interface LyricsDeps {
  readonly cache: KvCache;
  readonly clientFor: (library: LibraryRow) => Promise<WebDavClient>;
  /**
   * A folder's children. Backed by `TreeService.children`, so a folder the index has never
   * seen is materialized with a live `PROPFIND` and persisted.
   */
  readonly children: (library: LibraryRow, dirPath: string) => Promise<NodeRow[]>;
  readonly timeoutMs: number;
}

/**
 * One answer, whether it came from a sidecar or from the track.
 *
 * `text` is the **plain** form — timestamps stripped — because that is what the legacy
 * `getLyrics.value` field carries. `lines` is what `getLyricsBySongId` publishes, offsets
 * included.
 */
interface ResolvedLyrics {
  readonly synced: boolean;
  readonly lines: readonly LyricsLine[];
  readonly text: string;
}

type CachedLyrics = { readonly text: string } | { readonly missing: true };

const SIDECAR_SUFFIXES = ['.lrc', '.txt'] as const;
const GENERIC_SIDECAR_STEMS = new Set(['lyrics', 'song']);

/**
 * The sidecar this track's lyrics should come from, or `null`.
 *
 * Exact-stem match first (`.lrc` before `.txt`), then the conventional `lyrics.lrc` /
 * `song.lrc`, and a single unrelated sidecar only when it is the **only** one in the folder.
 * The last rule is deliberately narrow: a folder of tracks with one `notes.txt` should not
 * give every track the same lyrics, which is what "any `.txt` will do" produces.
 */
function chooseSidecar(children: readonly NodeRow[], songName: string): NodeRow | null {
  const songStem = stemOf(songName);
  const candidates: Array<{ node: NodeRow; score: number }> = [];

  for (const child of children) {
    const lowered = child.name.toLowerCase();
    const suffix = SIDECAR_SUFFIXES.find((candidate) => lowered.endsWith(candidate));
    if (suffix === undefined) continue;
    const stem = stemOf(lowered);
    const typeRank = suffix === '.lrc' ? 0 : 10;
    if (stem === songStem) {
      candidates.push({ node: child, score: typeRank });
    } else if (GENERIC_SIDECAR_STEMS.has(stem)) {
      candidates.push({ node: child, score: typeRank + 1 });
    }
  }

  if (candidates.length === 0) {
    const all = children.filter((child) => SIDECAR_SUFFIXES.some((suffix) => child.name.toLowerCase().endsWith(suffix)));
    return all.length === 1 ? all[0] : null;
  }

  candidates.sort((left, right) => left.score - right.score || left.node.name.localeCompare(right.node.name));
  return candidates[0].node;
}

function stemOf(name: string): string {
  const lowered = name.toLowerCase();
  const dot = lowered.lastIndexOf('.');
  return dot > 0 ? lowered.slice(0, dot) : lowered;
}

/**
 * The cache key for one song's lyrics.
 *
 * The sidecar's own path and revision are part of it, so replacing a `.txt` with a `.lrc`
 * or editing either one moves the key. Discovery therefore runs **before** the cache read:
 * a key built from the song alone would answer the old lyric for the new sidecar until the
 * entry aged out.
 *
 * `nodes` carries no size column, so a sidecar's revision is its `mtime_ms` and etag. Both
 * are written by the same `PROPFIND` that materialized the row, and either moving is what
 * a rewrite produces; the song half does carry size, which catches the case a tagger
 * changed bytes without moving the mtime.
 */
function lyricsKey(library: LibraryRow, song: LyricsSong, sidecar: NodeRow | null): string[] {
  const songRevision = `${song.mtime_ms}x${song.size}`;
  const sidecarRevision = sidecar === null ? 'embedded' : `${sidecar.path}:${sidecar.mtime_ms ?? 0}:${sidecar.etag ?? ''}`;
  return [library.id, song.path, `v${LYRICS_READER_VERSION}`, songRevision, sidecarRevision];
}

function toResult(text: string): ResolvedLyrics | null {
  const parsed = parseLyricsText(text);
  if (parsed.lines.length === 0) return null;
  return { synced: parsed.synced, lines: parsed.lines, text: parsed.lines.map((line) => line.text).join('\n') };
}

class LyricsService {
  constructor(private readonly deps: LyricsDeps) {}

  /**
   * Lyrics for one song, or `null` when there are none.
   *
   * `null` is an ordinary answer — an instrumental, a track nobody has transcribed — and
   * the endpoints render it as an empty payload. A failure to **read** also answers `null`,
   * because a lyric panel with nothing in it is better than a failed request, but only a
   * completed look is remembered.
   */
  public async forSong(library: LibraryRow, song: LyricsSong): Promise<ResolvedLyrics | null> {
    const discovered = await this.discover(library, song);
    const key = lyricsKey(library, song, discovered.sidecar);

    const hit = await this.fromCache(key);
    if (hit.hit) return hit.result;

    const client = await this.deps.clientFor(library);
    const resolved = await this.resolve(client, song, discovered.sidecar);
    // Cached only when every question was answered. A transient failure is not an
    // observation about the file, and this entry lasts 30 days.
    if (resolved.complete && !discovered.failed) {
      await this.deps.cache.putJson('songLyrics', key, resolved.result === null ? { missing: true } : { text: resolved.result.text });
    }
    return resolved.result;
  }

  /**
   * A cache hit, which can legitimately be a cached **absence** — so this answers whether
   * an entry existed rather than whether it held lyrics.
   */
  private async fromCache(key: string[]): Promise<{ hit: true; result: ResolvedLyrics | null } | { hit: false }> {
    const cached = await this.deps.cache.getJson<CachedLyrics>('songLyrics', key);
    if (cached === null) return { hit: false };
    return { hit: true, result: 'missing' in cached ? null : toResult(cached.text) };
  }

  /**
   * Read the sidecar, then the tags, and report whether both questions finished.
   *
   * A thrown read leaves `complete` false but does not stop the other source from being
   * tried: an unreadable sidecar is not evidence the track has no embedded lyric.
   */
  private async resolve(
    client: WebDavClient,
    song: LyricsSong,
    sidecar: NodeRow | null,
  ): Promise<{ result: ResolvedLyrics | null; complete: boolean }> {
    let complete = true;

    if (sidecar !== null) {
      try {
        const bytes = await client.readPrefix(sidecar.path, LYRICS_SIDECAR_BYTES, this.deps.timeoutMs);
        const result = toResult(decodeLyricsText(bytes));
        if (result !== null) return { result, complete };
      } catch (error) {
        complete = false;
        logger.warn(`Lyrics sidecar unreadable for ${sidecar.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const head = await client.readPrefix(song.path, LYRICS_PREFIX_BYTES, this.deps.timeoutMs);
      const embedded = readEmbeddedLyrics(head);
      return { result: embedded === null ? null : toResult(embedded), complete };
    } catch (error) {
      logger.warn(`Embedded lyrics unreadable for ${song.path}: ${error instanceof Error ? error.message : String(error)}`);
      return { result: null, complete: false };
    }
  }

  /**
   * The folder's sidecar candidates.
   *
   * `TreeService.children` is a D1 read on a materialized folder and a `PROPFIND` on one it
   * has never seen — the one subrequest this path spends before reading the lyric itself.
   * A failure here is reported as `failed`, not as "no sidecar": the two are different
   * observations, and only one of them may be cached.
   */
  private async discover(library: LibraryRow, song: LyricsSong): Promise<{ sidecar: NodeRow | null; failed: boolean }> {
    try {
      const children = await this.deps.children(library, song.dir_path);
      return { sidecar: chooseSidecar(children, song.name), failed: false };
    } catch (error) {
      logger.warn(`Lyrics folder unreadable for ${song.dir_path}: ${error instanceof Error ? error.message : String(error)}`);
      return { sidecar: null, failed: true };
    }
  }
}

export { LyricsService, chooseSidecar, lyricsKey, LYRICS_PREFIX_BYTES, LYRICS_SIDECAR_BYTES };
export type { CachedLyrics, LyricsDeps, LyricsSong, ResolvedLyrics };
