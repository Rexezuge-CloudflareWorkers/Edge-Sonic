/**
 * Shared helpers for turning D1 rows and services into Subsonic values.
 *
 * ### The id rules, restated where they are used
 *
 * - `song` ids are short and opaque (`subsonic/songId.ts`), resolved through
 *   the row — so `stream` reads the database where it once decoded the id.
 *   Legacy reversible ids are still accepted and resolve through
 *   `(library_id, path)`.
 * - `album` ids are the album's **grouping key**, never its name and no longer its directory —
 *   `ALBUM_GROUP_BY` decides what an album is, `subsonic/albumKey.ts` owns that question and
 *   `./albumIdentity.ts` carries it per request. A name would be the part that changes; a
 *   directory is only the album for some libraries. The directory-shaped id is still
 *   *accepted*, so a starred album from before the change still resolves.
 * - `artist` ids are derived from the artist grouping's directory when the artist
 *   is a single directory, and from the lowercase artist name otherwise (a
 *   compilation splits one artist across many directories and has no single
 *   folder).
 */
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { artistElement, artistIdOf, elList, legacySongId } from '@edge-sonic/subsonic';
import type { Child, ElementNode, Song } from '@edge-sonic/subsonic';
import type { AlbumIdentity } from './albumIdentity';

/**
Epoch seconds → the ISO-8601 form the protocol uses for `created` and `changed`.

### One formatter, because the wire format is part of the protocol

`toIso` strips the milliseconds, so an epoch second renders as `2024-03-01T00:00:00Z`.
`playlists.ts` had its own `isoOrUndefined`, identical except that it kept `.000Z` — so
`playlist.created` and `song.created`, the same field name on the same wire, had two
different spellings, and a client decoding one as a `LocalDateTime` accepted the other only
by luck.

`state.ts` had the body inlined **three** more times, for `bookmark.created`,
`bookmark.changed` and `playQueue.changed`. Four copies of an epoch conversion is four
places for the milliseconds rule to differ, and the repo's own record of this defect class
is `getAlbum`'s omitted `created`: two literals for one field, and a client whose model
declares `@SerialName("created") val createdAt: Instant` with no default fails on
**every** call.

Returns `undefined` for absent and for non-positive: an epoch of `0` is "no time known",
not 1970, and rendering it would publish a date the row does not claim. Every caller that
has already established the value is non-null uses the `!` form rather than inventing a
second helper with a different contract.
*/
function toIso(epochSeconds: number | null | undefined): string | undefined {
  return epochSeconds === null || epochSeconds === undefined || epochSeconds <= 0 ? undefined : new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function suffixOfPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot <= 0 ? '' : path.slice(dot + 1);
}

/**
A title for a row, and it is the stored one.

It used to re-derive one here, from the filename, when `title` was NULL — `01 - Holocene`
became `Holocene` at *read* time. That was cosmetic and correct-looking, and it was the
reason the absence went unnoticed for as long as it did: the mapper supplied a title the row
did not have, so every per-track surface looked healthy while `search3` (which filters on
`title_ci`) and `SongMatchDAO.findByAlbumTitle` (which matches on `(album_ci, title_ci)`) saw
a row with no title at all. A display fallback that never reaches the row is a comment about
a feature — 113 of 118 starred tracks reported `not-found` on the library where this was
measured.

The derivation now lives in `pathConvention.ts` and is written by the indexer, so `title` is
populated on the row and this is a read. The `|| song.name` is the one thing kept: a row with
no title at all shows its filename rather than an empty field, and it is a *read* fallback
rather than a second implementation of the naming rule.
*/
function titleOf(song: SongRow): string {
  return song.title ?? song.name;
}

/**
 * Album name for a row the scan has not tag-read: the containing folder's name.
 *
 * Lives beside `songToModel` rather than in an endpoint module because both consume it,
 * and an endpoint importing its way up to a shared derivation is how a second copy of the
 * path convention starts.
 *
 * `DERIVED_MARKER` is **not** stripped here, and that is a decision rather than an oversight. A
 * row the scan has not range-read carries `X (derived)` when the deployment configures that
 * marker, and a row it has carries `X`; the two are then deliberately different albums — see
 * `subsonic/albumKey.ts` — because the marker is the only *visible* record that a name is a
 * guess, and merging the two would publish a guess as a release name. The cost is that a
 * partially-enriched library lists one release twice, once under each spelling, which is a lesser
 * price than an album named after a filename convention and nothing saying so.
 *
 * The default marker is **empty**, so by default there is no suffix, the two spellings are the
 * same string, and this is the path where a derived `X` and a tagged `X` are one album. Both
 * answers are one variable; neither is a special case here.
 */
function albumNameOf(song: SongRow): string {
  if (song.album) return song.album;
  const slash = song.dir_path.lastIndexOf('/');
  const dir = song.dir_path.slice(slash + 1);
  return dir.length > 0 ? dir : 'Unknown Album';
}

/**
 * Artist name for a row with no tag: the album folder's parent, or `Unknown Artist` for a
 * file sitting at the library root, where there is no folder to read a name from.
 */
function artistNameOf(song: SongRow): string {
  if (song.artist) return song.artist;
  if (song.album_artist) return song.album_artist;
  const slash = song.dir_path.lastIndexOf('/');
  const dir = slash <= 0 ? song.dir_path : song.dir_path.slice(0, slash);
  return dir.length > 0 ? dir : 'Unknown Artist';
}

/**
 * The sort letter for index grouping, shared by the tag view and the folder view.
 *
 * A leading article is kept in the display name and stripped only from the
 * grouping letter, which is what every client does with `ignoredArticles`. An
 * empty or non-alphabetic first character sorts under `#` rather than into the
 * empty string, which would produce an unnamed group at the top of the list.
 *
 * One function rather than one per endpoint, because two groupings that disagree
 * on the letter put the same artist under `A` in one browse and `#` in the other.
 */
function firstLetterOf(name: string): string {
  const trimmed = name.trim();
  const first = [...trimmed].at(0);
  if (first === undefined) return '#';
  const upper = first.toUpperCase();
  return /^[A-Z]$/.test(upper) ? upper : '#';
}

interface ArtistGroup {
  readonly name: string;
  readonly albums: Set<string>;
  readonly songs: number;
}

/**
 * Song rows → artist groups, sorted by grouping key.
 *
 * The same grouping feeds `getArtists` and the artist half of `getIndexes`, so it
 * lives here rather than in either endpoint: two copies are free to disagree about
 * which name wins, and the disagreement shows up as an artist under two spellings.
 *
 * A real tag wins over a path-derived name, so the first row carrying a tag names
 * the group: a library half-enriched groups under the true name rather than under
 * a guess.
 *
 * `identity` rather than a grouping, because `albums` is a **set of album keys** and the key is
 * the grouping's answer — an artist's `albumCount` is "how many distinct albums is this artist on",
 * and under a tag grouping a compilation counts for every artist who contributed a track to it.
 * That is the honest answer for a library with no `ALBUMARTIST`: the artist page shows the album
 * in full, with the other artists' tracks on it, because a partial album is the one answer a
 * client cannot render.
 */
function groupArtistRows(rows: readonly SongRow[], identity: AlbumIdentity): ArtistGroup[] {
  const byName = new Map<string, { name: string; albums: Set<string>; songs: number }>();
  for (const row of rows) {
    const name = row.artist ?? artistNameOf(row);
    const key = name.toLowerCase();
    const albumKey = identity.keyOf(row);
    const existing = byName.get(key);
    if (existing) {
      existing.albums.add(albumKey);
      existing.songs += 1;
    } else {
      byName.set(key, { name: row.artist ?? name, albums: new Set([albumKey]), songs: 1 });
    }
  }
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

/**
 * Artist groups → the letter-bucketed `index` elements both browses publish.
 *
 * One construction, because the attribute set is the contract: `getArtists` and
 * `getIndexes` publish the same `id` for the same artist, or a client drilling
 * from one into `getArtist` lands on `code=70`. The `starred` decoration is the
 * caller's — the folder view does not annotate — so it arrives as a lookup rather
 * than as a second construction.
 */
function artistIndexGroups(library: LibraryRow, groups: readonly ArtistGroup[], starred: ReadonlyMap<string, number> = new Map()): ElementNode[] {
  const buckets = new Map<string, ElementNode[]>();
  for (const group of groups) {
    const id = artistIdOf(group.name);
    const letter = firstLetterOf(group.name);
    const starredAt = starred.get(id);
    const node = artistElement({
      id,
      name: group.name,
      albumCount: group.albums.size,
      // A client draws one image per artist row from `coverArt` via `getCoverArt`.
      // Omitting it leaves Navic and every other grid client with nothing to request,
      // so the artist list renders as empty tiles even when every album has art.
      // The id itself is the cover id: `getCoverArt` resolves it to the artist's
      // representative album (sidecar first, then embedded tags).
      coverArt: id,
      // The epoch second the artist was starred, or nothing. It used to be
      // `{ starred: undefined }`, which is *not* a decorated flag that decorates nothing —
      // `undefined` is dropped by both serializers, so the attribute did not exist at all
      // on either surface. An artist star is reachable only through here, because
      // `getStarred` deliberately does not expand one into its albums.
      ...(starredAt !== undefined && { starred: toIso(starredAt) }),
    });
    const existing = buckets.get(letter);
    if (existing) {
      existing.push(node);
    } else {
      buckets.set(letter, [node]);
    }
  }
  return [...buckets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artists]) => elList('index', 'artist', { name }, artists));
}

/**
 * This user's annotations, keyed by protocol id.
 *
 * `stars` is a **Map of id to the epoch second it was starred**, not a `Set`, and the
 * value is load-bearing. `starred` is a timestamp in the protocol — the same shape as
 * `created` on a song and an album — so an artist element can only publish it if the
 * lookup carries it. As a `Set` the only thing an element could write was `starred:
 * undefined`, which both serializers drop: no attribute in XML, no key in JSON, and a
 * star that was stored correctly and reported by nothing. A `Set` makes the wrong answer
 * the only available one, which is a type's way of saying a field is missing.
 */
interface AnnotationLookup {
  stars: Map<string, number>;
  ratings: Map<string, number>;
  playCounts: Map<string, number>;
}

/**
 * What a caller renders when it has no user's annotations to consult.
 *
 * One definition, because there were two of them — here and in `search.ts` — written out
 * separately. That is the same "two literals free to disagree" shape as the album model
 * this file already owns, and it is a `Set` versus a `Map` here, so the two versions could
 * not have been the same type.
 */
const NO_ANNOTATIONS: AnnotationLookup = { stars: new Map(), ratings: new Map(), playCounts: new Map() };

/**
 * An annotation for a song under either id it has ever been published under.
 *
 * Stars, ratings and play counts are stored under the id the song had when the
 * user marked it. Rotation renames the row but leaves these tables alone (they
 * resolve through the legacy fallback), so a lookup checks the row's current
 * id first and its legacy long form second — the same "current plus legacy"
 * shape `albumModel` uses for folder-shaped album ids.
 */
function annotationValue(lookup: ReadonlyMap<string, number> | undefined, song: SongRow): number | undefined {
  if (!lookup || lookup.size === 0) return undefined;
  const current = lookup.get(song.id);
  if (current !== undefined) return current;
  return lookup.get(legacySongId(song.library_id, song.path));
}

function songToModel(song: SongRow, library: LibraryRow, identity: AlbumIdentity, annotations?: AnnotationLookup): Song {
  const albumId = identity.idOf(song);
  // `artist` falls back for the same reason `album` does, four lines below — a row the
  // scan never tag-read and whose path yields no name still has to produce a record a
  // client can decode.
  //
  // It shipped as the one field in this literal with no fallback. A client whose `Song`
  // model is `@SerialName("artist") val artistName: String` — non-nullable, no default —
  // then throws on every track with an uninformative path, and a track at the library
  // root is exactly that. So: the same object emitted `album` derived from the folder and
  // `artist` absent, which is a record half-built.
  const artistName = artistNameOf(song);
  const artistId = artistIdOf(artistName);
  // The album artist, for the two OpenSubsonic fields carrying it. `album_artist` preferred,
  // `artist` as the fallback: a compilation's tracks each name their own performer while the
  // album names one thing, and a client grouping an album grid by `displayAlbumArtist` needs
  // the album's answer rather than each track's.
  const albumArtist = song.album_artist ?? song.artist ?? undefined;
  const title = titleOf(song);
  const starredAt = annotationValue(annotations?.stars, song);
  const rating = annotationValue(annotations?.ratings, song);
  const playCount = annotationValue(annotations?.playCounts, song) ?? 0;
  return {
    id: song.id,
    mediaType: 'song',
    title,
    // `albumNameOf`, not `basenameOf(albumDir)`. The two disagree for a track sitting at
    // the library root: `basenameOf('')` is `undefined`, so `getSong` omitted `album`
    // entirely while `getAlbum`/`getAlbumList2` published `"Unknown Album"` for the same
    // row. One derivation, one answer — which is the rule `albumModel` already exists to
    // enforce and which this literal was quietly exempt from.
    album: albumNameOf(song),
    albumId,
    artist: artistName,
    artistId,
    albumArtist,
    track: song.track ?? undefined,
    discNumber: song.disc ?? undefined,
    year: song.year ?? undefined,
    genre: song.genre ?? undefined,
    // 0 is emitted, not omitted: a client that gets no `duration` treats the
    // record as malformed and hides the track. 0 renders as "unknown length",
    // which every client tolerates.
    duration: song.duration,
    bitRate: song.bitrate,
    // Both read from the row the tag reader already filled, so publishing them costs no
    // WebDAV request. `undefined` rather than 0 for a track not yet read: 0 is a claim about
    // the audio, and this track's audio has not been looked at.
    samplingRate: song.sample_rate ?? undefined,
    channelCount: song.channels ?? undefined,
    size: song.size,
    contentType: song.content_type ?? guessContentType(song.suffix),
    suffix: song.suffix || suffixOfPath(song.path),
    created: toIso(song.created_at),
    ...(albumId !== undefined && { coverArt: albumId }),
    ...(starredAt !== undefined && { starred: toIso(song.mtime_ms) }),
    ...(rating !== undefined && { userRating: rating }),
    // Always a number, defaulting to 0. Omitting it leaves a client doing
    // `playCount + 1` rendering `NaN`, and `playCount` is a value every client displays
    // rather than an annotation that is either present or absent.
    playCount,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  ape: 'audio/x-monkeys-audio',
  wv: 'audio/x-wavpack',
  mpc: 'audio/x-musepack',
};

/**
 * A content type from the suffix.
 *
 * Never from a WebDAV `getcontenttype`, which is frequently `application/octet-
 * stream` for audio and occasionally *wrong*. A wrong `Content-Type` on a stream
 * makes some players refuse the file outright, and this is the value a client
 * uses to choose a decoder.
 */
function guessContentType(suffix: string): string {
  return CONTENT_TYPES[suffix.toLowerCase()] ?? 'audio/mpeg';
}

function songToChild(song: SongRow, library: LibraryRow, parentId: string, identity: AlbumIdentity, annotations?: AnnotationLookup): Child {
  const albumId = identity.idOf(song);
  const starredAt = annotationValue(annotations?.stars, song);
  const rating = annotationValue(annotations?.ratings, song);
  const playCount = annotationValue(annotations?.playCounts, song) ?? 0;
  return {
    id: song.id,
    parent: parentId,
    isDir: false,
    title: titleOf(song),
    // The same derivation as `songToModel`, and the same reasoning: a child and its parent
    // record describing one track cannot disagree about which album it is on.
    album: albumNameOf(song),
    artist: song.artist ?? song.album_artist ?? artistNameOf(song),
    track: song.track ?? undefined,
    discNumber: song.disc ?? undefined,
    year: song.year ?? undefined,
    genre: song.genre ?? undefined,
    coverArt: albumId,
    size: song.size,
    contentType: song.content_type ?? guessContentType(song.suffix),
    suffix: song.suffix || suffixOfPath(song.path),
    duration: song.duration,
    bitRate: song.bitrate,
    created: toIso(song.created_at),
    mediaType: 'song',
    ...(starredAt !== undefined && { starred: toIso(song.mtime_ms) }),
    ...(rating !== undefined && { userRating: rating }),
    // Always a number, defaulting to 0. Omitting it leaves a client doing
    // `playCount + 1` rendering `NaN`, and `playCount` is a value every client displays
    // rather than an annotation that is either present or absent.
    playCount,
  };
}

export { toIso, guessContentType, songToModel, songToChild, albumNameOf, artistNameOf, groupArtistRows, artistIndexGroups };
export { IGNORED_ARTICLES } from '@edge-sonic/subsonic';
export type { AlbumIdentity } from './albumIdentity';
export type { AnnotationLookup, ArtistGroup };
export { NO_ANNOTATIONS };
