/**
 * Shared helpers for turning D1 rows and services into Subsonic values.
 *
 * ### The id rules, restated where they are used
 *
 * - `song` ids come from `encodeId`, which is reversible, so `stream` can resolve
 *   an id to a path without a lookup.
 * - `album` ids are derived from `dir_path`, **never from the album name**. A
 *   starred album resolves to its songs by directory, so a name-derived id orphans
 *   every star the first time somebody renames a folder.
 * - `artist` ids are derived from the artist grouping's directory when the artist
 *   is a single directory, and from the lowercase artist name otherwise (a
 *   compilation splits one artist across many directories and has no single
 *   folder).
 */
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { encodeId, IdKind } from '@edge-sonic/subsonic';
import type { Child, Song } from '@edge-sonic/subsonic';

/**
Epoch seconds → the ISO-8601 form the protocol uses for `created`.
*/
function toIso(epochSeconds: number | null | undefined): string | undefined {
  return epochSeconds === null || epochSeconds === undefined || epochSeconds <= 0 ? undefined : new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
`2024-03-01T00:00:00.000Z` → epoch seconds, for the reverse direction.
*/
function fromIso(iso: string | null | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function suffixOfPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot <= 0 ? '' : path.slice(dot + 1);
}

/**
A title for a row the scan has not enriched: the filename without its suffix.
*/
function titleFromPath(song: SongRow): string {
  if (song.title) return song.title;
  const dot = song.name.lastIndexOf('.');
  const stem = dot > 0 ? song.name.slice(0, dot) : song.name;
  // `01 - Holocene` → `Holocene` when the folder is not tag-read yet. Purely
  // cosmetic, and it keeps a browsable library from showing a list of filenames.
  return stem.replace(/^\d{1,3}\s*[-._)]\s*/, '').trim() || song.name;
}

/**
 * Album name for a row the scan has not tag-read: the containing folder's name.
 *
 * Lives beside `songToModel` rather than in an endpoint module because both consume it,
 * and an endpoint importing its way up to a shared derivation is how a second copy of the
 * path convention starts.
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
 * The key an album groups under. `dir_path` when known, else the album name.
 */
function albumKeyOf(song: SongRow): string {
  return song.dir_path.length > 0 ? song.dir_path : `name:${albumNameOf(song)}`;
}

interface AnnotationLookup {
  stars: Set<string>;
  ratings: Map<string, number>;
  playCounts: Map<string, number>;
}

function songToModel(song: SongRow, library: LibraryRow, annotations?: AnnotationLookup): Song {
  const albumDir = song.dir_path;
  const albumId = albumDir.length > 0 ? encodeId(IdKind.Album, library.id, albumDir) : undefined;
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
  const artistId = encodeId(IdKind.Artist, library.id, artistName);
  return {
    id: song.id,
    mediaType: 'song',
    title: titleFromPath(song),
    album: song.album ?? basenameOf(albumDir),
    albumId,
    artist: artistName,
    artistId,
    track: song.track ?? undefined,
    discNumber: song.disc ?? undefined,
    year: song.year ?? undefined,
    genre: song.genre ?? undefined,
    // 0 is emitted, not omitted: a client that gets no `duration` treats the
    // record as malformed and hides the track. 0 renders as "unknown length",
    // which every client tolerates.
    duration: song.duration,
    bitRate: song.bitrate,
    size: song.size,
    contentType: song.content_type ?? guessContentType(song.suffix),
    suffix: song.suffix || suffixOfPath(song.path),
    created: toIso(song.created_at),
    ...((albumDir.length > 0) && { coverArt: albumId }),
    ...(annotations?.stars.has(song.id) && { starred: toIso(song.mtime_ms) }),
    ...(annotations?.ratings.has(song.id) && { userRating: annotations.ratings.get(song.id) }),
    // Always a number, defaulting to 0. Omitting it leaves a client doing
    // `playCount + 1` rendering `NaN`, and `playCount` is a value every client displays
    // rather than an annotation that is either present or absent.
    playCount: annotations?.playCounts.get(song.id) ?? 0,
  };
}

function basenameOf(path: string): string | undefined {
  if (path.length === 0) return undefined;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
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

function songToChild(song: SongRow, library: LibraryRow, parentId: string, annotations?: AnnotationLookup): Child {
  const albumDir = song.dir_path;
  return {
    id: song.id,
    parent: parentId,
    isDir: false,
    title: titleFromPath(song),
    album: song.album ?? basenameOf(albumDir),
    artist: song.artist ?? song.album_artist ?? artistNameOf(song),
    track: song.track ?? undefined,
    discNumber: song.disc ?? undefined,
    year: song.year ?? undefined,
    genre: song.genre ?? undefined,
    coverArt: albumDir.length > 0 ? encodeId(IdKind.Album, library.id, albumDir) : undefined,
    size: song.size,
    contentType: song.content_type ?? guessContentType(song.suffix),
    suffix: song.suffix || suffixOfPath(song.path),
    duration: song.duration,
    bitRate: song.bitrate,
    created: toIso(song.created_at),
    mediaType: 'song',
    ...(annotations?.stars.has(song.id) && { starred: toIso(song.mtime_ms) }),
    ...(annotations?.ratings.has(song.id) && { userRating: annotations.ratings.get(song.id) }),
    // Always a number, defaulting to 0. Omitting it leaves a client doing
    // `playCount + 1` rendering `NaN`, and `playCount` is a value every client displays
    // rather than an annotation that is either present or absent.
    playCount: annotations?.playCounts.get(song.id) ?? 0,
  };
}

export {
  toIso,
  fromIso,
  titleFromPath,
  guessContentType,
  songToModel,
  songToChild,
  basenameOf,
  albumNameOf,
  artistNameOf,
  albumKeyOf,
  CONTENT_TYPES,
};
export type { AnnotationLookup };
