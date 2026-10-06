/**
 * Album and song lists: `getAlbumList`, `getAlbumList2`, `getRandomSongs`,
 * `getSongsByGenre`, `getGenres`, `getStarred`, `getStarred2`, `getNowPlaying`.
 *
 * All aggregated from the `songs` index with an indexed `GROUP BY` rather than by
 * walking folders. `getAlbumList` (file-structure variant) and `getAlbumList2` (tag
 * variant) share one implementation, and they do so **deliberately** — the protocol
 * describes them as two views, but a server with two album identities answers
 * `getAlbumList2` and `getAlbum` with one album and `getAlbumList` with another, and a
 * client's album id is whichever it saw last. Navidrome answers both from its single
 * album table. The folder view is still reachable, through `getIndexes` and
 * `getMusicDirectory`, which is the protocol's actual folder browse.
 *
 * What *is* configurable is what an album is: see `ALBUM_GROUP_BY` and
 * `subsonic/albumKey.ts`. Both variants follow it, so a client that sends either gets the
 * same albums with the same ids.
 */
import { albumChildElement, albumElement, decodeId, el, elList, ErrorCode, IdKind, resolveAlbumId, songElement, SubsonicError } from '@edge-sonic/subsonic';
import type { Album, ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import type { AnnotationLookup } from '../mappers';
import { NO_ANNOTATIONS, songToModel } from '../mappers';
import { resolveLibraries } from './libraries';
import { annotationsFor } from './structured';
import { groupAlbumsOf } from './albumRecord';

/**
How each album-list type maps onto a `songs` query.

**Aggregate expressions, over a `GROUP BY dir_path`.** The group is the album's directory —
one group is one album, which is the property the whole paging contract rests on — so the
ordering has to be a function of the *group*, not of whichever track led it. `MIN(album_ci)`
rather than `album_ci`, or a ten-track album would sort as its first track and a
`GROUP BY` would pick that row arbitrarily: two calls could order the same album
differently, and `type=alphabeticalByName` would be stable only by accident.

An unknown type falls back to `random`, which is what the protocol's own default is.

`frequent`, `recent` and `highest` are the three that genuinely want play counts, last-play
times and ratings, and this server has none of them aggregated per album. They order by
recency rather than returning nothing, because a client paging "most played" is better
served by an ordering than by an empty list — but it is not the ordering it asked for, and
a server that has play counts should say so here rather than quietly substitute one.
*/
const ALBUM_ORDER_BY: Readonly<Record<string, readonly string[]>> = {
  random: ['RANDOM()'],
  newest: ['MAX(mtime_ms) DESC'],
  frequent: ['MAX(mtime_ms) DESC'],
  recent: ['MAX(mtime_ms) DESC'],
  highest: ['MAX(mtime_ms) DESC'],
  alphabeticalByName: ['MIN(album_ci) ASC'],
  alphabeticalByArtist: ['MIN(album_artist_ci) ASC', 'MIN(album_ci) ASC'],
  byYear: ['MIN(year) ASC', 'MIN(album_ci) ASC'],
  byGenre: ['MIN(genre_ci) ASC', 'MIN(album_ci) ASC'],
};

/**
Decode an id, or `null` when it is not of this kind or is malformed.
*/
function safeDecodeId(id: string, kind: string): ReturnType<typeof decodeId> | null {
  try {
    return decodeId(id, kind as never);
  } catch {
    // A star whose id this server can no longer decode — a deleted library, or a
    // row written before an id scheme change. Skipped rather than failing the
    // whole list: one stale star must not hide every other one.
    return null;
  }
}

/**
 * Render album models as the element type their wrapper declares.
 *
 * `albumList` is `Array of Child` and `albumList2` is `Array of AlbumID3` — the two
 * spellings of the same list, answered with different element types. So the wrapper
 * name decides, and the wrapper is the only thing that knows which it is: a grouping
 * that picked for itself picked `AlbumID3` for both, which put `title` and `isDir` on
 * every album in `getAlbumList2` where the schema declares neither.
 */
function renderAlbums(albums: readonly Album[], wrapperName: 'albumList' | 'albumList2'): ElementNode[] {
  return wrapperName === 'albumList' ? albums.map((album) => albumChildElement(album, album.artistId)) : albums.map((album) => albumElement(album));
}

/**
 * `getAlbumList` and `getAlbumList2`.
 *
 * `type` is **required** by the protocol, and the default here was a silent substitution:
 * a client that sent none got `random`, so a request that named no list came back with a
 * confident one. Navidrome refuses it with `code=10`, and so does this — a client asking
 * "give me the highest-rated albums" and receiving a random page has no way to tell that
 * the server substituted the question.
 *
 * An unrecognised `type` is a different failure and stays a different one. The protocol
 * names the accepted values, so anything else is a client bug rather than a missing
 * parameter: `code=0`, which is the protocol's generic failure, matching Navidrome.
 * Falling back to `random` for it would answer a question nobody asked.
 */
async function albumList(context: RestContext, wrapperName: 'albumList' | 'albumList2'): Promise<EnvelopeResponse> {
  const type = context.params.require('type');
  if (!(type in ALBUM_ORDER_BY) && type !== 'starred') {
    throw new SubsonicError(ErrorCode.Generic, `type '${type}' not implemented`);
  }
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const identity = context.albumsFor(library);
  const size = context.pageSize(context.params.optionalInt('size'), 10);
  const offset = context.params.int('offset', 0, { min: 0 });

  if (type === 'starred') {
    const starredIds = await context.annotations.listStarred(context.user.id, 'album');
    const annotations = await annotationsFor(context, starredIds.length > 0);
    return respond(context, elList(wrapperName, 'album', {}, renderAlbums(await starredAlbums(context, library, scope, starredIds, annotations), wrapperName)));
  }

  const needsRange = type === 'byYear' || type === 'byGenre';
  const rawFrom = context.params.int('fromYear', Number.MIN_SAFE_INTEGER);
  const rawTo = context.params.int('toYear', Number.MAX_SAFE_INTEGER);
  // A reversed range is the protocol's way of asking for reverse chronological.
  const fromYear = needsRange ? Math.min(rawFrom, rawTo) : Number.MIN_SAFE_INTEGER;
  const toYear = needsRange ? Math.max(rawFrom, rawTo) : Number.MAX_SAFE_INTEGER;
  const genre = type === 'byGenre' ? context.params.get('genre') : undefined;

  const rows = await context.songIndex.listAlbums(scope, {
    grouping: identity.grouping,
    genreCi: genre ? genre.toLowerCase() : null,
    ...(needsRange && { fromYear, toYear }),
    limit: size,
    offset,
    orderBy: ALBUM_ORDER_BY[type] ?? ALBUM_ORDER_BY.random,
  });

  return respond(context, elList(wrapperName, 'album', {}, renderAlbums(groupAlbumsOf(rows, library, identity, NO_ANNOTATIONS), wrapperName)));
}

/**
 * The albums a user has starred, deduplicated by the album they resolve to.
 *
 * ### Why the ids are resolved and then dropped
 *
 * A star is stored under the id the album had when the user starred it, and two stored ids can
 * now name one album: `Ex-Otogibanashi` was starred as two folders, and under a tag grouping
 * both folders are one album. Rendering both rows publishes **the same album twice** in a list
 * whose whole job is to be a set — and the client sees two tiles that open the same record.
 *
 * So the stored ids are resolved to keys, the keys are deduplicated, and the rows are fetched
 * once per key. The alternative, trusting that a star's id is still its album's id, is the same
 * assumption that made a folder rename orphan every star.
 *
 * @param annotations Carried through so `albumModel` can find the star it is rendering — the
 *   id it publishes is the *current* one, and the stored one is not among them.
 */
async function starredAlbums(
  context: RestContext,
  library: LibraryRow,
  scope: LibraryScope,
  starredIds: readonly string[],
  annotations: AnnotationLookup,
): Promise<Album[]> {
  if (starredIds.length === 0) return [];
  const identity = context.albumsFor(library);
  const keys: string[] = [];
  for (const id of starredIds) {
    const key = await resolveAlbumId(id, identity.grouping, async (dirPath) => await context.songs.listByAlbumDir(library.id, dirPath));
    // A star whose album has gone resolves to nothing and is skipped rather than failing the
    // list: one stale row must not hide every other star, which is the same rule
    // `safeDecodeId` applies to an id this server can no longer decode.
    if (key === null || keys.includes(key)) continue;
    keys.push(key);
  }
  if (keys.length === 0) return [];
  const rows = await context.songIndex.listForAlbumKeys(scope, keys, identity.grouping);
  return groupAlbumsOf(rows, library, identity, annotations);
}

async function getAlbumList(context: RestContext): Promise<EnvelopeResponse> {
  return await albumList(context, 'albumList');
}

async function getAlbumList2(context: RestContext): Promise<EnvelopeResponse> {
  return await albumList(context, 'albumList2');
}

/**
Wrap rows as song elements with one set of annotation lookups for the page.
*/
async function songNodes(context: RestContext, library: LibraryRow, rows: readonly SongRow[]): Promise<ElementNode[]> {
  const ids = rows.map((row) => row.id);
  const annotations = await annotationsFor(context, ids.length > 0);
  const identity = context.albumsFor(library);
  return rows.map((row) => songElement(songToModel(row, library, identity, annotations)));
}

async function getRandomSongs(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const size = context.pageSize(context.params.optionalInt('size'), 10);
  const genre = context.params.get('genre');
  const fromYear = context.params.int('fromYear', Number.MIN_SAFE_INTEGER);
  const toYear = context.params.int('toYear', Number.MAX_SAFE_INTEGER);
  const rows = await context.songs.listRandom(library.id, {
    genreCi: genre ? genre.toLowerCase() : null,
    ...((fromYear !== Number.MIN_SAFE_INTEGER) && { fromYear }),
    ...((toYear !== Number.MAX_SAFE_INTEGER) && { toYear }),
    limit: size,
  });
  return respond(context, elList('randomSongs', 'song', {}, await songNodes(context, library, rows)));
}

async function getSongsByGenre(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const genre = context.params.require('genre');
  const count = context.pageSize(context.params.optionalInt('count'), 10);
  const offset = context.params.int('offset', 0, { min: 0 });
  const rows = await context.songs.listByGenre(library.id, genre.toLowerCase(), count + offset, 0);
  return respond(context, elList('songsByGenre', 'song', {}, await songNodes(context, library, rows.slice(offset, offset + count))));
}

/**
 * `getGenres` — the library's genres, with real song and album counts.
 *
 * The counts come from the aggregate in `listGenres` rather than from counting rows
 * here. That used to be the implementation, over a `GROUP BY genre_ci` result whose
 * rows are one track each — so every genre reported `songCount: 1`, and a client using
 * the count to decide whether to offer a genre filter was reading a number that had
 * nothing to do with the library.
 */
async function getGenres(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const rows = await context.songIndex.listGenres(scope);
  const nodes = rows
    .filter((row) => row.value.trim().length > 0)
    .map((row) => el('genre', { value: row.value, songCount: row.song_count, albumCount: row.album_count }));
  return respond(context, elList('genres', 'genre', {}, nodes));
}

/**
 * `getStarred` / `getStarred2` — starred songs and albums.
 *
 * Artist stars are **not** expanded into albums here. A starred artist can have
 * hundreds of albums, and a client calling `getStarred` expects a page, not a
 * library; expanding it would make one request proportional to a whole discography.
 * Starred artists are visible through `getArtists`, which reports `starred` on the
 * artist element itself.
 */
async function starred(context: RestContext, wrapperName: 'starred' | 'starred2'): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const [songIds, albumIds] = await Promise.all([
    context.annotations.listStarred(context.user.id, 'song'),
    context.annotations.listStarred(context.user.id, 'album'),
  ]);

  const songIdsHere = songIds.filter((id) => safeDecodeId(id, IdKind.Song)?.libraryId === library.id);
  const songs = await context.songs.listIdsIn(library.id, songIdsHere);

  const annotations = await annotationsFor(context, songIds.length + albumIds.length > 0);
  // Through `starredAlbums`, not a per-id directory read: an album's identity is now a tag for
  // most libraries, so a starred *folder* id has to resolve through the group or the starred
  // list publishes half of an album the rest of the server publishes whole.
  const albums = await starredAlbums(context, library, scope, albumIds, annotations);
  // `starred` and `starred2` declare both an `album` and a `song` key, so the wrapper is
  // a record either way. An album in that wrapper is a `Child`, matching `starred`'s own
  // schema — see `renderAlbums` for why the element type follows the wrapper.
  const albumNodes = albums.map((album) => albumChildElement(album, album.artistId));
  return respond(context, elList(wrapperName, ['album', 'song'], {}, [...albumNodes, ...(await songNodes(context, library, songs))]));
}

async function getStarred(context: RestContext): Promise<EnvelopeResponse> {
  return await starred(context, 'starred');
}

async function getStarred2(context: RestContext): Promise<EnvelopeResponse> {
  return await starred(context, 'starred2');
}

/**
 * `getNowPlaying` — populated by `scrobble`, and deliberately narrow.
 *
 * Only entries whose song is still in the index are reported, and only for the
 * caller's library. A scrobble for a track that has since been deleted is silently
 * dropped rather than shown as a broken entry.
 */
async function getNowPlaying(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, undefined);
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const identity = context.albumsFor(library);
  const entries = await context.annotations.listNowPlaying();
  const nodes: ElementNode[] = [];
  for (const entry of entries) {
    if (!entry.song_id || (safeDecodeId(entry.song_id, IdKind.Song)?.libraryId !== library.id)) continue;
    const song = await context.songs.findById(entry.song_id);
    if (!song) continue;
    nodes.push({
      ...songElement(songToModel(song, library, identity)),
      // The wrapper declares `entry` as its list key, and the element name is the JSON
      // key a client reads. Leaving this as `song` puts the payload under
      // `nowPlaying.song` and leaves `nowPlaying.entry` as its empty seed, so a client
      // following the schema sees nobody playing forever.
      name: 'entry',
      children: [
        el('username', {}, [entry.username]),
        el('minutesAgo', {}, [entry.minutes_ago]),
        ...(entry.player_name ? [el('playerName', {}, [entry.player_name])] : []),
        ...(entry.player_id ? [el('playerId', {}, [entry.player_id])] : []),
      ],
    });
  }
  return respond(context, elList('nowPlaying', 'entry', {}, nodes));
}

const listEndpoints = {
  getAlbumList,
  getAlbumList2,
  getRandomSongs,
  getSongsByGenre,
  getGenres,
  getStarred,
  getStarred2,
  getNowPlaying,
};

export { listEndpoints, getAlbumList, getAlbumList2, getRandomSongs, getSongsByGenre, getGenres, getStarred, getStarred2, getNowPlaying };


