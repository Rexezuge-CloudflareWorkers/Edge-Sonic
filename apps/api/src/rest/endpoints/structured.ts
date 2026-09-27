/**
 * Tag-organized browsing: `getArtists`, `getArtist`, `getAlbum`, `getSong`.
 *
 * This is the view modern clients actually use (Symfonium, DSub, play:sub), and it
 * is the one that needs the materialized `songs` index — a recursive `PROPFIND` per
 * request cannot answer "every album by this artist, newest first".
 *
 * ### The grouping, and where it can be wrong
 *
 * Artists and albums are derived from the path convention *and* from tags, and
 * neither is authoritative. A library with no tags groups by folder name; a tagged
 * library groups by tag. Both are supported, which means the grouping is a
 * **view** over `songs` rather than a stored entity — and that is the reason album
 * ids are derived from `dir_path` and never from the album name: the name is
 * precisely the part that is allowed to change.
 */
import { albumElement, artistElement, decodeId, el, elList, encodeId, ErrorCode, IdKind, songElement, SubsonicError, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import type { AnnotationLookup } from '../mappers';
import { songToModel, titleFromPath } from '../mappers';
import { resolveLibrary } from './browse';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/** Album name for a row the scan has not tag-read: the containing folder's name. */
function albumNameOf(song: SongRow): string {
  if (song.album) return song.album;
  const slash = song.dir_path.lastIndexOf('/');
  const dir = song.dir_path.slice(slash + 1);
  return dir.length > 0 ? dir : 'Unknown Album';
}

function artistNameOf(song: SongRow): string {
  if (song.artist) return song.artist;
  if (song.album_artist) return song.album_artist;
  const slash = song.dir_path.lastIndexOf('/');
  const dir = slash <= 0 ? song.dir_path : song.dir_path.slice(0, slash);
  return dir.length > 0 ? dir : 'Unknown Artist';
}

/** The key an album groups under. `dir_path` when known, else the album name. */
function albumKeyOf(song: SongRow): string {
  return song.dir_path.length > 0 ? song.dir_path : `name:${albumNameOf(song)}`;
}

async function annotationsFor(context: RestContext, ids: readonly string[]): Promise<AnnotationLookup> {
  if (ids.length === 0) return { stars: new Set(), ratings: new Map(), playCounts: new Map() };
  const [songStars, albumStars, artistStars, songRatings, albumRatings, artistRatings, playCounts] = await Promise.all([
    context.annotations.listStarred(context.user.id, 'song'),
    context.annotations.listStarred(context.user.id, 'album'),
    context.annotations.listStarred(context.user.id, 'artist'),
    context.annotations.listRatings(context.user.id, 'song'),
    context.annotations.listRatings(context.user.id, 'album'),
    context.annotations.listRatings(context.user.id, 'artist'),
    context.annotations.listPlayCounts(context.user.id),
  ]);
  return {
    stars: new Set([...songStars, ...albumStars, ...artistStars]),
    ratings: new Map([...songRatings, ...albumRatings, ...artistRatings]),
    playCounts,
  };
}

/**
 * `getArtists` — every artist, grouped by index letter.
 *
 * Aggregated from `songs` in one indexed pass rather than by walking folders,
 * because the tag view's whole point is that it is not the folder view.
 */
async function getArtists(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const limit = context.pageSize(context.params.int('size', undefined), 500);
  const offset = context.params.int('offset', 0, { min: 0 });

  const rows = await context.songs.listArtists(library.id, limit + offset, 0);
  const byName = new Map<string, { albums: Set<string>; songs: number }>();
  for (const row of rows) {
    const name = artistNameOf(row);
    const key = (row.artist ?? name).toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.albums.add(albumKeyOf(row));
      existing.songs += 1;
    } else {
      byName.set(key, { albums: new Set([albumKeyOf(row)]), songs: 1 });
    }
  }

  const annotations = await annotationsFor(context, [...byName.keys()]);
  const buckets = new Map<string, ElementNode[]>();
  const ordered = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(offset, offset + limit);

  for (const [key, group] of ordered) {
    const name = rows.find((row) => (row.artist ?? artistNameOf(row)).toLowerCase() === key);
    if (!name) continue;
    const id = encodeId(IdKind.Artist, library.id, name.artist ?? artistNameOf(name));
    const letter = /^[A-Z]/i.test(name.artist ?? artistNameOf(name)) ? (name.artist ?? artistNameOf(name))[0]!.toUpperCase() : '#';
    const node = artistElement({
      id,
      name: name.artist ?? artistNameOf(name),
      albumCount: group.albums.size,
      ...(annotations.stars.has(id) ? { starred: undefined } : {}),
    });
    const existing = buckets.get(letter);
    if (existing) {
      existing.push(node);
    } else {
      buckets.set(letter, [node]);
    }
  }

  const indexes = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artists]) => elList('index', 'artist', { name }, artists));

  return respond(context, elList('artists', 'index', { ignoredArticles: 'The El La Los Las Le Les' }, indexes));
}

/** `getArtist` — an artist's albums. */
async function getArtist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Artist);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  const artistName = decoded.path;

  const all = await context.songs.listArtists(library.id, 5000, 0);
  const mine = all.filter((row) => (row.artist ?? artistNameOf(row)).toLowerCase() === artistName.toLowerCase());
  if (mine.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');

  const annotations = await annotationsFor(context, [id]);
  const albums = groupAlbums(mine, library, annotations);
  return respond(context, elList('artist', 'album', { id, name: artistName, albumCount: albums.length }, albums));
}

/**
 * Group songs into album elements.
 *
 * **The key is `dir_path`, not the album name.** A starred album resolves back to
 * its songs through this key, so a name-derived key would orphan every star the
 * first time somebody fixed a typo in a folder name.
 */
function groupAlbums(rows: readonly SongRow[], library: LibraryRow, annotations: AnnotationLookup): ElementNode[] {
  const groups = new Map<string, SongRow[]>();
  for (const row of rows) {
    const key = albumKeyOf(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const starred = new Set([...annotations.stars]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, songs]) => {
      const first = songs[0]!;
      const id = encodeId(IdKind.Album, library.id, key.startsWith('name:') ? key : key);
      songs.sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name));
      return albumElement({
        id,
        name: albumNameOf(first),
        artist: first.artist ?? first.album_artist ?? undefined,
        artistId: encodeId(IdKind.Artist, library.id, first.artist ?? first.album_artist ?? artistNameOf(first)),
        songCount: songs.length,
        duration: songs.reduce((total, song) => total + song.duration, 0),
        year: first.year ?? undefined,
        genre: first.genre ?? undefined,
        coverArt: id,
        created: first.created_at > 0 ? new Date(first.created_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined,
        ...(starred.has(id) ? { starred: new Date(first.mtime_ms).toISOString() } : {}),
        ...(annotations.ratings.has(id) ? { userRating: annotations.ratings.get(id) } : {}),
      });
    });
}

/** `getAlbum` — an album's songs. */
async function getAlbum(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Album);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  TreeService.assertPath(decoded.path);

  const songs = await context.songs.listByAlbumDir(library.id, decoded.path);
  if (songs.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');

  const annotations = await annotationsFor(context, songs.map((song) => song.id));
  const ordered = [...songs].sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name));
  const first = ordered[0]!;
  const album = {
    id,
    name: albumNameOf(first),
    artist: first.artist ?? first.album_artist ?? undefined,
    artistId: encodeId(IdKind.Artist, library.id, first.artist ?? first.album_artist ?? artistNameOf(first)),
    songCount: ordered.length,
    duration: ordered.reduce((total, song) => total + song.duration, 0),
    year: first.year ?? undefined,
    genre: first.genre ?? undefined,
    coverArt: id,
    ...(annotations.stars.has(id) ? { starred: new Date(first.mtime_ms).toISOString() } : {}),
    ...(annotations.ratings.has(id) ? { userRating: annotations.ratings.get(id) } : {}),
  };

  // `albumElement` builds the attribute set from the domain model; the songs are
  // children, so they are attached afterwards rather than by reshaping the model
  // into an attrs object.
  return respond(context, { ...albumElement(album), children: ordered.map((song) => songElement(songToModel(song, library, annotations))) });
}

/**
 * `getSong` — one track, enriched on demand.
 *
 * This is where `duration` and `bitRate` get filled in. The enrichment is a single
 * ranged read of the file's first bytes, cached in D1 and KV, and it is bounded by
 * "one per song the client actually opens" rather than "one per indexed track" —
 * which is the only way it fits under the subrequest limit.
 */
async function getSong(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Song);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  TreeService.assertPath(decoded.path);

  let song = await context.songs.findById(id);
  if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');

  await context.enrichment.enrich(library, song);
  // Re-read: the enrichment wrote duration, bitrate, and tags to D1, and the
  // in-memory row still has the pre-enrichment zeros.
  song = (await context.songs.findById(id)) ?? song;

  const annotations = await annotationsFor(context, [id]);
  return respond(context, songElement(songToModel(song, library, annotations)));
}

/** Handlers only — the registry rejects a signature that is not `(context) => ...`. */
const structuredEndpoints = { getArtists, getArtist, getAlbum, getSong };

export {
  structuredEndpoints,
  getArtists,
  getArtist,
  getAlbum,
  getSong,
  groupAlbums,
  albumNameOf,
  artistNameOf,
  albumKeyOf,
  annotationsFor,
};
export type { AnnotationLookup as StructuredAnnotationLookup };
